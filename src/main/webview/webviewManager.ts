import { WebContentsView, ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import type { CaptureSource, Platform, RoomInfo, RoomStatus, SendResult } from '../../shared/types'
import { FRAME_CHANNELS, IPC } from '../../shared/types'
import { getAdapter, type DirectClient, type DirectHooks, type PlatformAdapter } from '../adapters'
import { bus } from './bus'
import { createCdpCapture, type CdpCapture } from './cdpCapture'
import { CLEAR_VIDEO_MODE_SCRIPT, PLAYER_FRAME_RE, VIDEO_MODE_SCRIPT } from './inject/videoMode'

interface RoomSession {
  info: RoomInfo
  adapter: PlatformAdapter
  view: WebContentsView
  gotWsMeta: boolean
  domMode: boolean
  retryCount: number
  /** 被平台跳到异常页后「拉回房间页」的次数（防无限循环） */
  navRetries: number
  watchdog: NodeJS.Timeout
  /** 主进程直连抓取客户端；非空时它是弹幕帧的唯一来源，页面侧信号一律忽略 */
  direct: DirectClient | null
  /** CDP 抓帧通道（能看到 Worker 内的连接）；非空时不再注入页面 hook，避免双源重复 */
  cdp: CdpCapture | null
  /** CDP 正在启动中：期间也不能注入 hook，否则等它起来会形成双源 */
  cdpPending: boolean
  /** 已确认真的在推送弹幕的那条连接（仅用于日志） */
  cdpEndpointUrl: string | null
  /** 页面是否已切到「纯视频模式」（避免每次尺寸变化重复注入） */
  videoMode: boolean
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

function handleFrame(room: RoomSession, data: Uint8Array, source: CaptureSource): number {
  let result: ReturnType<PlatformAdapter['parseFrame']>
  try {
    result = room.adapter.parseFrame(Buffer.from(data), room.info.roomId, source)
  } catch (err) {
    console.error('[wv] frame parse error', err)
    return 0
  }
  if (result.danmaku.length === 0 && result.onlineCount === undefined) return 0
  markCaptured(room)
  for (const msg of result.danmaku) bus.publish(msg)
  if (result.onlineCount !== undefined) {
    emitStat(room, result.onlineCount)
    return result.danmaku.length + 1
  }
  return result.danmaku.length
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
  // Electron 默认 UA 带「Electron」字样，容易被平台识别为内嵌环境。
  // 这里统一伪装成标准 Chrome（预防性措施：虎牙/快手等站点的反爬会看 UA）。
  view.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  )
  const session: RoomSession = {
    info: { roomId, platform, status: 'loading', addedAt: Date.now() },
    adapter,
    view,
    gotWsMeta: false,
    domMode: false,
    retryCount: 0,
    navRetries: 0,
    watchdog: null as unknown as NodeJS.Timeout,
    direct: null,
    cdp: null,
    cdpPending: false,
    cdpEndpointUrl: null,
    videoMode: false
  }
  rooms.set(roomId, session)

  // 放到屏幕外隐藏，仍保持网络与 JS 活动
  const host = mainWindow
  if (host) host.contentView.addChildView(view)
  view.setBounds(OFFSCREEN_BOUNDS)
  // 默认静音：只有被 UI 指定为「当前画面」的房间才出声（见 setVideoTarget）
  view.webContents.setAudioMuted(true)

  // 平台声明的「异常导航」一律拦截（如虎牙把房间页前端跳到错误页）。
  // 拦下后页面停在原位，DOM 兜底照常工作；正常导航不受影响。
  view.webContents.on('will-navigate', (e, url) => {
    if (adapter.isBlockedNavigation?.(url)) {
      e.preventDefault()
      console.warn(`[wv] 已拦截 ${platform} 的异常跳转: ${String(url).slice(0, 80)}`)
    }
  })
  // 跳回手段：部分平台的跳转不走 will-navigate（如 history 替换）或拦不住，
  // 一旦真的落在异常页，延迟片刻拉回房间页 —— 每次回到房间页，弹幕组件都会
  // 重新初始化，DOM 兜底在窗口期内即可抓到弹幕。限次防无限循环。
  view.webContents.on('did-navigate', (_e, url) => {
    if (!adapter.isBlockedNavigation?.(url)) return
    if (!alive() || session.navRetries >= 3) return
    session.navRetries += 1
    console.warn(
      `[wv] ${platform} 落在异常页，第 ${session.navRetries}/3 次拉回房间页: ${String(url).slice(0, 70)}`
    )
    setTimeout(() => {
      if (!alive() || session.domMode) return
      void view.webContents.loadURL(adapter.roomUrl(roomId)).catch(() => undefined)
    }, 1500)
  })

  // 进房准备（仅平台声明时执行）：清残留会话 / 预热首页。失败都继续尝试进房间。
  try {
    await adapter.resetSession?.()
  } catch (err) {
    console.warn(`[wv] ${platform} 会话重置失败（继续进房间）：`, String(err))
  }
  if (adapter.warmupUrl) {
    console.log(`[wv] ${platform} 预热首页：${adapter.warmupUrl()}`)
    try {
      await view.webContents.loadURL(adapter.warmupUrl())
      console.log(`[wv] ${platform} 预热完成`)
    } catch (err) {
      console.warn(`[wv] ${platform} 预热首页失败（继续进房间）：`, String(err))
    }
    if (rooms.get(roomId) !== session) return
  }

  /** 房间仍在册时才改状态/推事件（防止已关闭房间的迟到回调污染 UI） */
  const alive = (): boolean => rooms.get(roomId) === session

  const armWatchdog = (): void => {
    clearTimeout(session.watchdog)
    session.watchdog = setTimeout(() => {
      if (session.gotWsMeta || session.domMode || session.direct) return
      // ⚠️ 有 DOM 兜底的平台**不做 reload**：reload 会打断正在进行的页面加载
      // （实测虎牙：房间页拿到 ERR_ABORTED 后页面被前端跳到错误页），
      // 而这类平台的抓取本就不依赖 WS，直接进 DOM 兜底更稳。
      if (adapter.domFallbackScript() || session.retryCount >= 1) {
        startDomFallback(session)
        return
      }
      session.retryCount += 1
      view.webContents.reload()
      armWatchdog()
    }, 8000)
  }

  view.webContents.on('dom-ready', async () => {
    // 页面重载后 window 是新的一份，纯视频模式需要重新应用（含播放器 iframe）
    if (session.videoMode) void applyVideoMode(session)
    // 直连 / CDP 模式下页面只承担「发送」职责，不注入 WS hook，避免同一批弹幕被两个来源各发一遍
    if (session.direct || session.cdp || session.cdpPending) return
    await view.webContents.executeJavaScript(adapter.injectScript()).catch(() => 'inject-failed')
  })

  /**
   * 播放器 iframe 加载完成后补一次注入。
   * 首次注入常常落在 `about:blank` 上并随导航失效，这里是最直接的补救。
   */
  view.webContents.on('did-frame-finish-load', () => {
    if (!session.videoMode) return
    void injectVideoMode(session)
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

  // ② 次选：CDP 抓帧——浏览器进程级事件，Worker 内的连接同样可见（抖音等平台走这条）
  if (adapter.captureViaCdp) {
    // ⚠️ 顺序至关重要（实测）：**必须先发起 loadURL，再附加调试器**。
    // 在页面开始加载之前 attach，`Network.enable` 会一直不返回（实测 8s 超时后失败），
    // 而这里如果 await 它，「添加房间」就会整个卡住。
    const nav = view.webContents.loadURL(adapter.roomUrl(roomId))
    session.cdpPending = true
    // 与页面注入路径同等的兜底：8 秒内没抓不到任何帧就重载一次，再不行如实报错
    armWatchdog()
    void startCdpCapture(session).then((ok) => {
      session.cdpPending = false
      if (!alive()) return
      if (ok) return
      console.warn('[wv] CDP 抓帧不可用，退回页面注入')
      void view.webContents.executeJavaScript(adapter.injectScript()).catch(() => undefined)
    })
    try {
      await nav
    } catch (err) {
      // CDP 负责抓取，页面加载失败只影响「发送」，如实记录而不判死整条链路
      console.warn('[wv] CDP 模式下页面加载失败（仅影响发送，抓取不受影响）:', String(err))
    }
    return
  }

  // ③ 兜底：页面注入 + DOM 观察（快手/斗鱼/虎牙当前走这条）
  armWatchdog()
  // 诊断：页面被前端改写成错误页 / 加载被中断时，这里能看到真实轨迹
  view.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.warn(`[wv] 页面加载失败(${session.info.platform} ${roomId}) code=${code} ${desc} url=${String(url).slice(0, 90)}`)
  })
  view.webContents.on('did-redirect-navigation', (_e, url) => {
    console.warn(`[wv] 页面被重定向(${session.info.platform} ${roomId}) -> ${String(url).slice(0, 90)}`)
  })
  view.webContents.on('did-navigate', (_e, url) => {
    console.log(`[wv] 页面导航完成(${session.info.platform} ${roomId}) -> ${String(url).slice(0, 70)}`)
  })
  // ⚠️ 页面加载失败**不能判死房间**：看门狗会在 8 秒后 reload 一次来兜底，
  // 这个 reload 会打断这里的 await（ERR_ABORTED）。抓取靠页面注入/DOM 观察，
  // 与「这次导航是否被中断」无关 —— 与 CDP 分支同一处理原则。
  try {
    await view.webContents.loadURL(adapter.roomUrl(roomId))
  } catch (err) {
    console.warn(`[wv] ${platform} 房间页加载未完成（不影响抓取，仅影响发送）：`, String(err))
  }
}

/**
 * 用 CDP 抓帧：`webContents.debugger` + Network 域。
 *
 * 之所以单列一条通道：实测 B 站把弹幕连接建在 **blob Worker** 内，
 * 主世界 `window.WebSocket` patch 看不到；抖音这类平台也可能如此。
 * CDP 事件是浏览器进程级的，Worker 内的连接一样能看到，还能拿到端点 URL 做过滤。
 *
 * ⚠️ `onFrame` 必须**返回是否真的被消费**：端点识别可能不准，
 * 所以未确认通道前所有 WS 帧都上送试探，由 `parseFrame` 严格校验；
 * 一旦某条连接产出过数据，就只认它，省掉无谓解析。
 */
async function startCdpCapture(room: RoomSession): Promise<boolean> {
  const capture = createCdpCapture(
    room.view.webContents.debugger,
    {
      onEndpoint: (url) => {
        console.log('[wv] CDP 识别到弹幕端点:', url)
        armFrameWatchdog(room)
      },
      onFrame: (raw, source, url) => {
        const produced = handleFrame(room, raw, source)
        if (produced > 0 && !room.cdpEndpointUrl) {
          room.cdpEndpointUrl = url
          console.log('[wv] CDP 锁定弹幕帧来源:', url)
        }
        return produced > 0
      },
      onStreamHint: (url, chunks) => {
        console.warn(
          `[wv] 检测到疑似 HTTP 推流（已 ${chunks} 个分片）：${url}\n` +
            '[wv] 当前未做流式重组，若此平台弹幕抓不到，请把这条日志反馈以便按真实帧补实现'
        )
      },
      onError: (message) => console.warn('[wv] CDP 抓取异常:', message),
      onLog: (level, message) => console.log(`[wv][cdp:${level}] ${message}`)
    },
    {
      isDanmakuWs: (url) => room.adapter.isDanmakuWs(url),
      isDanmakuStream: room.adapter.isDanmakuStream
    }
  )
  const ok = await capture.start()
  if (!ok) {
    capture.stop()
    return false
  }
  room.cdp = capture
  return true
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
      // DOM 兜底已接管时同样丢弃页面 WS 帧：虎牙的 wsapi 补充源弹幕必然
      // 已出现在页面聊天列表里，不丢弃会双源重复
      if (room.domMode) return
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
  room.cdp?.stop() // 必须 detach：否则调试器悬挂在已关闭的 webContents 上
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

/** 承载播放器的子 frame（B 站用 live.bilibili.com/blanc/<room> 承载，顶层看不到 <video>） */
function playerFrames(room: RoomSession): Electron.WebFrameMain[] {
  try {
    const main = room.view.webContents.mainFrame
    return main.framesInSubtree.filter((f) => f !== main && PLAYER_FRAME_RE.test(f.url))
  } catch {
    return []
  }
}

/**
 * 注入一次纯视频脚本，返回顶层脚本自报的状态（'applied' / 'waiting' / ...）。
 */
async function injectVideoMode(room: RoomSession): Promise<string> {
  const wc = room.view.webContents
  const top = await wc.executeJavaScript(VIDEO_MODE_SCRIPT).catch(() => 'err')
  // 同源 iframe 顶层脚本自己能进去；这里主要覆盖跨域播放器
  const frames = playerFrames(room)
  await Promise.all(frames.map((f) => f.executeJavaScript(VIDEO_MODE_SCRIPT).catch(() => 'err')))
  return String(top)
}

/**
 * 应用「纯视频模式」。
 *
 * 顶层脚本会自己钻进同源播放器 iframe（见 inject/videoMode.ts 顶部注释），
 * 但有两件事必须由主进程兜住：
 * 1. **帧刚创建时注入可能落在 `about:blank` 上**，脚本会随该文档的导航一起被销毁
 *    （连它内部的定时器也一起消失）→ 必须轮询补注，直到脚本自报已生效；
 * 2. 跨域播放器读不到 `contentDocument` → 只能按 frame 注入。
 *
 * ⚠️ 判据不能用「找到几个 frame」：帧存在 ≠ 注入生效。
 */
async function applyVideoMode(room: RoomSession): Promise<void> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    if (!room.videoMode) return
    const status = await injectVideoMode(room)
    if (status === 'applied') {
      console.log(`[wv] 纯视频模式已应用（播放器 iframe ${playerFrames(room).length} 个）`)
      return
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  console.warn('[wv] 纯视频模式未确认生效：播放器可能仍在加载，或该平台播放器为跨域')
}

async function clearVideoMode(room: RoomSession): Promise<void> {
  const wc = room.view.webContents
  await wc.executeJavaScript(CLEAR_VIDEO_MODE_SCRIPT).catch(() => undefined)
  const frames = playerFrames(room)
  await Promise.all(frames.map((f) => f.executeJavaScript(CLEAR_VIDEO_MODE_SCRIPT).catch(() => undefined)))
}

export function setVideoTarget(roomId: string | null, rect: VideoRect | null): void {
  const usable =
    roomId !== null &&
    rect !== null &&
    rect.width >= MIN_VISIBLE_SIZE &&
    rect.height >= MIN_VISIBLE_SIZE

  const next = usable ? roomId : null
  let logBounds = false
  if (next !== videoTargetRoomId) {
    videoTargetRoomId = next
    logBounds = true
    const want = usable ? `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.x)},${Math.round(rect.y)}` : '-'
    console.log(next ? `[wv] 直播画面切换到房间 ${next} 目标尺寸 ${want}` : '[wv] 直播画面已隐藏')
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
      if (show && logBounds) {
        // 每次切台校验一次：确认真把视图摆到了面板位置（该位置错位会整层盖住弹幕区）
        const got = room.view.getBounds()
        console.log(`[wv] 视图 bounds 实际=${got.width}x${got.height}@${got.x},${got.y}`)
      }
      // 只有正在展示的房间出声：多房间同时播放会声音混叠
      room.view.webContents.setAudioMuted(!show)

      // 展示时把页面裁成「只剩播放器」，移走时还原（只做一次，尺寸变化不重复注入）
      if (show && !room.videoMode) {
        room.videoMode = true
        void applyVideoMode(room)
      } else if (!show && room.videoMode) {
        room.videoMode = false
        void clearVideoMode(room)
      }
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
  'need-login':
    '当前页面是游客态，平台不渲染弹幕输入框 —— 请先在顶部「👤 账号」登录',
  'no-input': '未找到弹幕输入框（可能是非直播间页面，或该房间不支持发言）',
  'no-setter': '找到输入框但类型不受支持，无法写入文本',
  'set-failed': '文本没有真正写进输入框（富文本编辑器拦截或页面改版），已放弃发送',
  'send-failed': '已填入文本但未找到发送按钮',
  'not-confirmed':
    '已提交但页面未确认弹幕发出（可能被平台拦截、频控，或发送后输入框未清空）—— 请在直播间页面核对是否真的发出'
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
    // 平台侧发送前准备（B 站：补全 CSRF Cookie，缺它发送会被服务端 -111 拒掉）
    if (room.adapter.prepareSend) await room.adapter.prepareSend()
    // 页面脚本可返回同步失败码，或返回 Promise（五平台统一确认发送：
    // 点击后轮询输入框清空，resolve 'sent'/'not-confirmed'；executeJavaScript 自动 await）。
    // 'queued' 仅作兼容保留（旧脚本形态），现所有适配器均已迁移到确认模式。
    const result = (await room.view.webContents.executeJavaScript(
      room.adapter.sendScript(text)
    )) as string
    if (result === 'sent' || result === 'queued') return { ok: true }
    return { ok: false, reason: SEND_FAIL_REASON[result] ?? `发送脚本返回未知结果：${result}` }
  } catch (err) {
    console.error('[wv] sendText failed', err)
    return { ok: false, reason: `执行发送脚本异常：${String(err)}` }
  }
}
