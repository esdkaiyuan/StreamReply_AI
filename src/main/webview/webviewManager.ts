import { WebContentsView, ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import type { Platform, RoomInfo, RoomStatus } from '../../shared/types'
import { IPC } from '../../shared/types'
import { getAdapter, type PlatformAdapter } from '../adapters'
import { bus } from './bus'

interface RoomSession {
  info: RoomInfo
  adapter: PlatformAdapter
  view: WebContentsView
  gotWsMeta: boolean
  domMode: boolean
  retryCount: number
  watchdog: NodeJS.Timeout
}

const rooms = new Map<string, RoomSession>()
let mainWindow: BrowserWindow | null = null
let domSeq = 0

export function bindMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

function setStatus(room: RoomSession, status: RoomStatus): void {
  room.info.status = status
  mainWindow?.webContents.send(IPC.roomStatusChanged, room.info)
}

/** 收到任意一帧可解析数据即视为抓取成功（不依赖平台是否走 WebSocket） */
function markCaptured(room: RoomSession): void {
  if (!room.gotWsMeta) {
    room.gotWsMeta = true
    room.domMode = false // 主通道生效后退出兜底，DOM 批次由 domMode 守卫生效
    setStatus(room, 'connected')
  }
  clearTimeout(room.watchdog)
}

function handleFrame(room: RoomSession, data: Uint8Array): void {
  const source = room.domMode ? 'dom' : 'ws'
  let result: ReturnType<PlatformAdapter['parseFrame']>
  try {
    result = room.adapter.parseFrame(Buffer.from(data), room.info.roomId, source)
  } catch (err) {
    console.error('[wv] frame parse error', err)
    return
  }
  if (result.danmaku.length === 0 && result.onlineCount === undefined) return
  markCaptured(room)
  for (const msg of result.danmaku) bus.publish(msg)
  if (result.onlineCount !== undefined) {
    mainWindow?.webContents.send(
      IPC.roomStat,
      bus.buildStat(room.info.platform, room.info.roomId, result.onlineCount)
    )
  }
}

function startDomFallback(room: RoomSession): void {
  if (room.domMode) return
  const script = room.adapter.domFallbackScript()
  if (!script) {
    // 该平台暂无 DOM 兜底（选择器待确认），如实报错而不是假装已连上
    console.warn(`[wv] ${room.info.platform} 无 DOM 兜底脚本，放弃该房间`)
    setStatus(room, 'error')
    return
  }
  room.domMode = true
  // 注入成功≠容器就绪：'fallback-dom' 由 dom-ready 信号（容器真正找到并开始观察）置位
  void room.view.webContents.executeJavaScript(script).catch((err) => {
    console.error('[wv] dom fallback inject failed', err)
    setStatus(room, 'error')
  })
}

export async function openRoom(platform: Platform, roomId: string): Promise<void> {
  if (rooms.has(roomId)) return
  const adapter = getAdapter(platform)
  if (!adapter) throw new Error(`平台 ${platform} 的适配器尚未实现`)

  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/webview.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  const session: RoomSession = {
    info: { roomId, platform, status: 'loading', addedAt: Date.now() },
    adapter,
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
    await view.webContents.executeJavaScript(adapter.injectScript()).catch(() => 'inject-failed')
  })

  view.webContents.on('render-process-gone', (_e, details) => {
    console.error('[wv] renderer gone', details.reason)
    setStatus(session, 'error')
  })

  // 直播间页面弹新窗一律拒绝
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  ensureIpcRoutes()

  armWatchdog()
  await view.webContents.loadURL(adapter.roomUrl(roomId))
}

/** IPC 路由模块级幂等注册一次，按 sender 路由到对应房间（避免每房间重复注册导致泄漏） */
let routesRegistered = false
function ensureIpcRoutes(): void {
  if (routesRegistered) return
  routesRegistered = true
  const roomBySender = (sender: Electron.WebContents): RoomSession | undefined =>
    Array.from(rooms.values()).find((r) => r.view.webContents === sender)

  const onFrame = (channel: string): void => {
    ipcMain.on(channel, (e, data: Uint8Array) => {
      const room = roomBySender(e.sender)
      if (room) handleFrame(room, data)
    })
  }

  ipcMain.on(IPC.wvInjectReady, () => {
    /* hook 安装确认，无需处理 */
  })
  ipcMain.on(IPC.wvDomReady, (e) => {
    const room = roomBySender(e.sender)
    if (room && room.domMode) setStatus(room, 'fallback-dom') // 仅兜底模式下接受，防主通道接管后状态回跳
  })
  ipcMain.on(IPC.wvWsMeta, (e, url: string) => {
    const room = roomBySender(e.sender)
    if (!room) return
    if (!room.adapter.isDanmakuWs(String(url))) return // 只认本平台的弹幕端点，避免页面内其他 WS 误判
    room.gotWsMeta = true
    room.domMode = false
    clearTimeout(room.watchdog)
    setStatus(room, 'connected')
    console.log('[wv] danmaku ws:', url)
  })
  onFrame(IPC.wvFrame)
  onFrame(IPC.wvDouyinFrame)
  onFrame(IPC.wvDouyinBody)
  ipcMain.on(IPC.wvDomMessages, (e, messages: Array<{ nickname: string; content: string }>) => {
    const room = roomBySender(e.sender)
    if (!room || !room.domMode) return // 主通道已接管后到达的 DOM 批次丢弃，防双源重复弹幕
    for (const m of messages) {
      bus.publish({
        id: `dom:${room.info.platform}:${room.info.roomId}:${Date.now()}:${Math.abs(hash(m.content))}:${domSeq++}`,
        platform: room.info.platform,
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

/** 向指定房间发送弹幕；找不到输入框视为失败（触发调度器熔断计数） */
export async function sendText(roomId: string, text: string): Promise<boolean> {
  const room = rooms.get(roomId)
  if (!room) return false
  try {
    const result = (await room.view.webContents.executeJavaScript(
      room.adapter.sendScript(text)
    )) as string
    return result === 'queued'
  } catch (err) {
    console.error('[wv] sendText failed', err)
    return false
  }
}
