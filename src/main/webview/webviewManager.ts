import { WebContentsView, ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import type { CaptureSource, Platform, RoomInfo, RoomStatus, SendResult } from '../../shared/types'
import { FRAME_CHANNELS, IPC } from '../../shared/types'
import { getAdapter, type DirectClient, type DirectHooks, type PlatformAdapter } from '../adapters'
import { bus } from './bus'

interface RoomSession {
  info: RoomInfo
  adapter: PlatformAdapter
  view: WebContentsView
  gotWsMeta: boolean
  domMode: boolean
  retryCount: number
  watchdog: NodeJS.Timeout
  /** 主进程直连抓取客户端；非空时它是弹幕帧的唯一来源，页面侧信号一律忽略 */
  direct: DirectClient | null
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

/**
 * 只有「真正解析出可用的帧」才算抓取成功。
 * 不能拿「发现了弹幕 WS 端点」当连上的依据——同一主机上还跑着 WebRTC 信令等无关连接，
 * 那样会显示「在线」却一条弹幕都没有，比如实报兜底更有误导性。
 */
function markCaptured(room: RoomSession): void {
  room.gotWsMeta = true
  room.domMode = false // 主通道生效后退出兜底，DOM 批次由 domMode 守卫生效
  setStatus(room, 'connected')
  clearTimeout(room.watchdog)
}

/** 已识别到弹幕端点但迟迟没有帧 → 交给 DOM 兜底（传输方式无关） */
function armFrameWatchdog(room: RoomSession, delayMs = 10_000): void {
  clearTimeout(room.watchdog)
  room.watchdog = setTimeout(() => {
    if (room.domMode) return
    startDomFallback(room)
  }, delayMs)
}

function emitStat(room: RoomSession, onlineCount: number): void {
  mainWindow?.webContents.send(
    IPC.roomStat,
    bus.buildStat(room.info.platform, room.info.roomId, onlineCount)
  )
}

function handleFrame(room: RoomSession, data: Uint8Array, source: CaptureSource): void {
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
  if (result.onlineCount !== undefined) emitStat(room, result.onlineCount)
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
    watchdog: null as unknown as NodeJS.Timeout,
    direct: null
  }
  rooms.set(roomId, session)

  // 放到屏幕外隐藏，仍保持网络与 JS 活动
  const host = mainWindow
  if (host) host.contentView.addChildView(view)
  view.setBounds(OFFSCREEN_BOUNDS)
  // 默认静音：只有被 UI 指定为「当前画面」的房间才出声（见 setVideoTarget）
  view.webContents.setAudioMuted(true)

  /** 房间仍在册时才改状态/推事件（防止已关闭房间的迟到回调污染 UI） */
  const alive = (): boolean => rooms.get(roomId) === session

  const armWatchdog = (): void => {
    clearTimeout(session.watchdog)
    session.watchdog = setTimeout(() => {
      if (session.gotWsMeta || session.domMode || session.direct) return
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
    // 直连模式下页面只承担「发送」职责，不注入 WS hook，避免与直连形成双源
    if (session.direct) return
    await view.webContents.executeJavaScript(adapter.injectScript()).catch(() => 'inject-failed')
  })

  view.webContents.on('render-process-gone', (_e, details) => {
    console.error('[wv] renderer gone', details.reason)
    // 直连模式下抓取不依赖页面，页面挂了只影响发送，不该把房间判死
    if (alive() && !session.direct) setStatus(session, 'error')
  })

  // 直播间页面弹新窗一律拒绝
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  ensureIpcRoutes()

  // ① 优先：主进程直连弹幕服务器——不依赖页面传输层，绕开「连接建在 Worker 内」
  if (adapter.createDirectCapture) {
    const hooks: DirectHooks = {
      onAuthOk: (serverHost) => {
        if (!alive()) return
        console.log('[wv] 直连鉴权通过，已连上弹幕服务器:', serverHost)
        setStatus(session, 'connected')
      },
      onFrame: (raw) => {
        if (alive()) handleFrame(session, raw, 'ws')
      },
      onPopularity: (count) => {
        if (alive()) emitStat(session, count)
      },
      onError: (message) => {
        if (!alive()) return
        console.warn('[wv] 直连抓取不可用，退回 DOM 观察:', message)
        session.direct?.stop()
        session.direct = null
        startDomFallback(session)
      },
      onLog: (level, message) => console.log(`[wv][direct:${level}] ${message}`)
    }
    try {
      session.direct = await adapter.createDirectCapture(roomId, hooks)
    } catch (err) {
      console.warn('[wv] 直连模式初始化失败，退回页面注入:', String(err))
      session.direct = null
    }
    if (session.direct) {
      session.direct.start()
      // 直连仍可收弹幕，页面加载失败只影响「发送」；重试一次后如实记录，不判死整条链路
      try {
        await view.webContents.loadURL(adapter.roomUrl(roomId))
      } catch (err) {
        console.warn('[wv] 直连模式下页面加载失败，重试一次:', String(err))
        try {
          await view.webContents.loadURL(adapter.roomUrl(roomId))
        } catch (retryErr) {
          console.warn('[wv] 页面重试仍失败（仅影响发送，抓取不受影响）:', String(retryErr))
        }
      }
      return
    }
  }

  // ② 兜底：页面注入 + DOM 观察（抖音/快手/斗鱼/虎牙当前走这条）
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
      if (!room || room.direct) return // 直连模式下页面帧一律不采信
      handleFrame(room, data, room.domMode ? 'dom' : 'ws')
    })
  }

  ipcMain.on(IPC.wvInjectReady, () => {
    /* hook 安装确认，无需处理 */
  })
  // 画面位置：渲染进程测量占位区后上报（尺寸变化频繁，用 send 而非 invoke）
  ipcMain.on(IPC.videoSetTarget, (_e, roomId: string | null, rect: VideoRect | null) => {
    setVideoTarget(roomId ? String(roomId) : null, rect && typeof rect === 'object' ? rect : null)
  })
  ipcMain.on(IPC.wvDomReady, (e) => {
    const room = roomBySender(e.sender)
    if (room && room.domMode) setStatus(room, 'fallback-dom') // 仅兜底模式下接受，防主通道接管后状态回跳
  })
  ipcMain.on(IPC.wvWsMeta, (e, url: string) => {
    const room = roomBySender(e.sender)
    if (!room || room.direct) return // 直连已接管时忽略页面端点信号
    if (!room.adapter.isDanmakuWs(String(url))) return // 只认本平台的弹幕端点，避免页面内其他 WS 误判
    room.gotWsMeta = true
    console.log('[wv] 识别到弹幕端点，等待首帧:', url)
    // 已挂上端点但 10 秒内没有任何帧 → 走 DOM 兜底，不假装已连上
    armFrameWatchdog(room)
  })
  // 遍历抓取通道注册表：新增平台无需改动这里
  for (const { channel } of Object.values(FRAME_CHANNELS)) onFrame(channel)
  ipcMain.on(IPC.wvDomMessages, (e, messages: Array<{ nickname: string; content: string }>) => {
    const room = roomBySender(e.sender)
    if (!room || !room.domMode || room.direct) return // 主通道已接管后到达的 DOM 批次丢弃，防双源重复弹幕
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
  rooms.delete(roomId) // 先摘除，后续任何迟到回调都会被 alive() 拦住
  room.direct?.stop()
  if (mainWindow) mainWindow.contentView.removeChildView(room.view)
  void room.view.webContents.close()
  setStatus(room, 'closed')
}

export function listRooms(): RoomInfo[] {
  return Array.from(rooms.values()).map((r) => ({ ...r.info }))
}

/**
 * 重载所有房间页面。
 * 登录态变化后必须调用：Cookie 变了但页面不会自己重新渲染，
 * 游客态→登录态才有弹幕输入框，发送链路才可能成功。
 */
export function reloadAllRooms(): void {
  for (const room of rooms.values()) {
    try {
      room.view.webContents.reload()
    } catch (err) {
      console.warn('[wv] 重载房间页面失败:', String(err))
    }
  }
}

/**
 * 把某个房间的画面搬到可见区域（其余房间移回屏外）。
 *
 * 为什么这么做：原生 WebContentsView 一直以 x:-20000 挂在窗口上（所以听得到声音），
 * 直接改 bounds 就能看到真实画面，无需逆向拉流派 URL（签名 + Referer 校验，极脆弱）。
 * `rect` 为 null 或过小时表示面板已折叠/被遮挡，全部移回屏外。
 */
/** 当前正在展示画面的房间（仅用于日志与切台判断） */
let videoTargetRoomId: string | null = null

export function setVideoTarget(roomId: string | null, rect: VideoRect | null): void {
  const usable =
    roomId !== null &&
    rect !== null &&
    rect.width >= MIN_VISIBLE_SIZE &&
    rect.height >= MIN_VISIBLE_SIZE

  const next = usable ? roomId : null
  if (next !== videoTargetRoomId) {
    videoTargetRoomId = next
    console.log(next ? `[wv] 直播画面切换到房间 ${next}` : '[wv] 直播画面已隐藏')
  }

  for (const room of rooms.values()) {
    const show = usable && room.info.roomId === roomId
    try {
      if (show) {
        room.view.setBounds({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        })
      } else {
        room.view.setBounds(OFFSCREEN_BOUNDS)
      }
      // 只有正在展示的房间出声：多房间同时播放会声音混叠
      room.view.webContents.setAudioMuted(!show)
    } catch (err) {
      console.warn('[wv] 调整画面位置失败:', room.info.roomId, String(err))
    }
  }
}

/** 可见区域矩形（单位与页面 CSS px 一致，即 Electron 的 DIP） */
export interface VideoRect {
  x: number
  y: number
  width: number
  height: number
}

/** 隐藏位置：屏幕外仍保持渲染与网络活动（这也是能听到声音的原因） */
const OFFSCREEN_BOUNDS = { x: -20000, y: 0, width: 1280, height: 800 }
/** 小于这个尺寸说明面板已折叠/不可见，按隐藏处理，避免 setBounds 报错 */
const MIN_VISIBLE_SIZE = 8

/** 页面脚本的失败码 → 可自助解决的中文说明（不要笼统说「未找到输入框」） */
const SEND_FAIL_REASON: Record<string, string> = {
  'page-not-ready': '直播间页面尚未加载完成，请稍后重试',
  'need-login': '当前页面是游客态，B 站不渲染弹幕输入框 —— 请先在顶部「👤 账号」登录',
  'no-input': '未找到弹幕输入框（可能是非直播间页面，或该房间不支持发言）',
  'no-setter': '找到输入框但类型不受支持，无法写入文本',
  'send-failed': '已填入文本但未找到发送按钮'
}

/** 向指定房间发送弹幕；失败时给出可读原因（触发调度器熔断计数） */
export async function sendText(roomId: string, text: string): Promise<SendResult> {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, reason: '房间不存在或已关闭' }
  // 页面没加载完就注入脚本，只会白白计一次熔断失败
  if (room.view.webContents.isLoading()) {
    return { ok: false, reason: '直播间页面正在加载，请稍后重试' }
  }
  try {
    const result = (await room.view.webContents.executeJavaScript(
      room.adapter.sendScript(text)
    )) as string
    if (result === 'queued') return { ok: true }
    return { ok: false, reason: SEND_FAIL_REASON[result] ?? `发送脚本返回未知结果：${result}` }
  } catch (err) {
    console.error('[wv] sendText failed', err)
    return { ok: false, reason: `执行发送脚本异常：${String(err)}` }
  }
}
