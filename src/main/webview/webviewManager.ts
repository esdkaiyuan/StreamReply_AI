import { WebContentsView, ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { brotliDecompressSync } from 'zlib'
import type { DanmakuMessage, Platform, RoomInfo, RoomStatus } from '../../shared/types'
import { IPC } from '../../shared/types'
import { OP, splitPackets } from '../adapters/bilibili/protocol'
import { mapBilibiliEvent } from '../adapters/bilibili/mapper'
import { WS_HOOK_SCRIPT } from './inject/wsHook'
import { DOM_OBSERVER_SCRIPT } from './inject/domObserver'
import { bus } from './bus'

interface RoomSession {
  info: RoomInfo
  view: WebContentsView
  gotWsMeta: boolean
  domMode: boolean
  retryCount: number
  watchdog: NodeJS.Timeout
}

const PLATFORM_URL: Record<Platform, (id: string) => string> = {
  bilibili: (id) => `https://live.bilibili.com/${id}`,
  douyin: (id) => `https://live.douyin.com/${id}`,
  kuaishou: (id) => `https://live.kuaishou.com/u/${id}`
}

const rooms = new Map<string, RoomSession>()
let mainWindow: BrowserWindow | null = null

export function bindMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

function setStatus(room: RoomSession, status: RoomStatus): void {
  room.info.status = status
  mainWindow?.webContents.send(IPC.roomStatusChanged, room.info)
}

function handleFrame(room: RoomSession, data: Uint8Array): void {
  const buf = Buffer.from(data)
  try {
    for (const packet of splitPackets(buf)) {
      if (packet.op !== OP.MESSAGE) continue // 认证/心跳由页面自身处理
      let bodies: Buffer[]
      if (packet.protover === 3) {
        bodies = splitPackets(brotliDecompressSync(packet.body)).map((p) => p.body)
      } else if (packet.protover === 0) {
        bodies = [packet.body]
      } else continue
      for (const body of bodies) {
        let event: Record<string, unknown>
        try { event = JSON.parse(body.toString('utf8')) } catch { continue }
        const cmd = String(event['cmd'] ?? '')
        const mapped = mapBilibiliEvent(cmd, event, room.info.roomId, room.domMode ? 'dom' : 'ws')
        if (mapped && 'type' in mapped) bus.publish(mapped as DanmakuMessage)
        else if (mapped) {
          mainWindow?.webContents.send(IPC.roomStat, mapped)
        }
      }
    }
  } catch (err) {
    console.error('[wv] frame parse error', err)
  }
}

function startDomFallback(room: RoomSession): void {
  if (room.domMode) return
  room.domMode = true
  void room.view.webContents.executeJavaScript(DOM_OBSERVER_SCRIPT).then(() => {
    setStatus(room, 'fallback-dom')
  })
}

export async function openRoom(platform: Platform, roomId: string): Promise<void> {
  if (rooms.has(roomId)) return
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/webview.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const session: RoomSession = {
    info: { roomId, platform, status: 'loading', addedAt: Date.now() },
    view,
    gotWsMeta: false,
    domMode: false,
    retryCount: 0,
    watchdog: null as unknown as NodeJS.Timeout
  }
  rooms.set(roomId, session)

  // 放到屏幕外隐藏，仍保持网络与 JS 活动
  const host = mainWindow
  if (host) host.contentView.addChildView(view)
  view.setBounds({ x: -20000, y: 0, width: 1280, height: 800 })

  const armWatchdog = (): void => {
    clearTimeout(session.watchdog)
    session.watchdog = setTimeout(() => {
      if (session.gotWsMeta || session.domMode) return
      if (session.retryCount < 1) {
        session.retryCount += 1
        view.webContents.reload()
        armWatchdog()
      } else {
        startDomFallback(session)
      }
    }, 8000)
  }

  view.webContents.on('dom-ready', async () => {
    await view.webContents.executeJavaScript(WS_HOOK_SCRIPT).catch(() => 'inject-failed')
  })

  view.webContents.on('render-process-gone', (_e, details) => {
    console.error('[wv] renderer gone', details.reason)
    setStatus(session, 'error')
  })

  ensureIpcRoutes()

  armWatchdog()
  await view.webContents.loadURL(PLATFORM_URL[platform](roomId))
}

/** IPC 路由模块级幂等注册一次，按 sender 路由到对应房间（避免每房间重复注册导致泄漏） */
let routesRegistered = false
function ensureIpcRoutes(): void {
  if (routesRegistered) return
  routesRegistered = true
  const roomBySender = (sender: Electron.WebContents): RoomSession | undefined =>
    Array.from(rooms.values()).find((r) => r.view.webContents === sender)

  ipcMain.on(IPC.wvInjectReady, () => { /* hook 安装确认，无需处理 */ })
  ipcMain.on(IPC.wvWsMeta, (e, url: string) => {
    const room = roomBySender(e.sender)
    if (!room) return
    room.gotWsMeta = true
    clearTimeout(room.watchdog)
    setStatus(room, 'connected')
    console.log('[wv] danmaku ws:', url)
  })
  ipcMain.on(IPC.wvFrame, (e, data: Uint8Array) => {
    const room = roomBySender(e.sender)
    if (room) handleFrame(room, data)
  })
  ipcMain.on('wv:dom-messages', (e, messages: Array<{ nickname: string; content: string }>) => {
    const room = roomBySender(e.sender)
    if (!room) return
    for (const m of messages) {
      bus.publish({
        id: `bili:${room.info.roomId}:${Date.now()}:${Math.abs(hash(m.content))}`,
        platform: 'bilibili',
        roomId: room.info.roomId,
        type: 'chat',
        user: { uid: '', nickname: m.nickname },
        content: m.content,
        ts: Date.now(),
        source: 'dom'
      })
    }
  })
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

export function closeRoom(roomId: string): void {
  const room = rooms.get(roomId)
  if (!room) return
  clearTimeout(room.watchdog)
  if (mainWindow) mainWindow.contentView.removeChildView(room.view)
  void room.view.webContents.close()
  rooms.delete(roomId)
  setStatus(room, 'closed')
}

export function listRooms(): RoomInfo[] {
  return Array.from(rooms.values()).map((r) => ({ ...r.info }))
}
