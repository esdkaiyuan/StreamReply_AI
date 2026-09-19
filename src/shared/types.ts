export type Platform = 'bilibili' | 'douyin' | 'kuaishou' | 'douyu' | 'huya'
export type DanmakuType = 'chat' | 'enter' | 'gift' | 'like' | 'follow' | 'share'
export type CaptureSource = 'ws' | 'dom'
export type RoomStatus = 'idle' | 'loading' | 'connected' | 'fallback-dom' | 'error' | 'closed'

export interface DanmakuUser {
  uid: string
  nickname: string
  avatar?: string
  /** 粉丝勋章等级（非舰长守卫等级） */
  medalLevel?: number
}

export interface GiftInfo { name: string; count: number; /** 单价，单位：元 */ price: number }

export interface DanmakuMessage {
  id: string
  platform: Platform
  roomId: string
  type: DanmakuType
  user: DanmakuUser
  content: string
  gift?: GiftInfo
  ts: number
  source: CaptureSource
}

export interface RoomStatEvent {
  platform: Platform
  roomId: string
  onlineCount?: number
  danmakuRate: number
  /** 该房间累计收到的弹幕条数（用于自查抓取是否在工作） */
  danmakuCount?: number
  /** 该房间的真实抓取通道描述（由适配器能力推导，非写死文案） */
  captureChannel?: string
  /** 本地 SQLite 落盘是否可用（真实探测，不挂靠 AI 状态） */
  dbAvailable?: boolean
  /** 库内弹幕总条数（COUNT(*)，真实值） */
  dbTotalCount?: number
  ts: number
}

export interface RoomInfo {
  roomId: string
  platform: Platform
  status: RoomStatus
  addedAt: number
}

export const IPC = {
  roomAdd: 'room:add',
  roomRemove: 'room:remove',
  roomList: 'room:list',
  roomStatusChanged: 'room:status-changed',
  danmaku: 'danmaku:message',
  roomStat: 'room:stat',
  wvFrame: 'wv:frame',
  wvWsMeta: 'wv:ws-meta',
  wvInjectReady: 'wv:inject-ready',
  wvDomReady: 'wv:dom-ready',
  wvDomMessages: 'wv:dom-messages',
  wvSendText: 'wv:send-text',
  wvDouyinFrame: 'wv:dy-frame',
  wvDouyinBody: 'wv:dy-body',
  wvKuaishouFrame: 'wv:ks-frame',
  wvDouyuFrame: 'wv:douyu-frame',
  wvHuyaFrame: 'wv:huya-frame',
  videoSetTarget: 'video:set-target',
  replyUpdate: 'reply:update',
  replyConfirm: 'reply:confirm',
  replyReject: 'reply:reject',
  replyRetry: 'reply:retry',
  replyEdit: 'reply:edit',
  replyManual: 'reply:manual',
  aiToggle: 'ai:toggle',
  aiLog: 'ai:log',
  aiState: 'ai:state',
  manualSend: 'manual:send',
  historyDanmaku: 'history:danmaku',
  historyExport: 'history:export',
  historyReplies: 'history:replies',
  authState: 'auth:state',
  authChanged: 'auth:changed',
  authQrStart: 'auth:qr-start',
  authQrPoll: 'auth:qr-poll',
  authCookieSet: 'auth:cookie-set',
  authOpenLoginWindow: 'auth:open-login-window',
  authLogout: 'auth:logout',
  authPlatformState: 'auth:platform-state',
  authPlatformLoginWindow: 'auth:platform-login-window',
  authPlatformCookieSet: 'auth:platform-cookie-set',
  authPlatformLogout: 'auth:platform-logout',
  authPlatformAccounts: 'auth:platform-accounts',
  authPlatformSwitch: 'auth:platform-switch',
  authPlatformRemove: 'auth:platform-remove',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set'
} as const

export interface AddRoomResult { ok: boolean; error?: string }

/** 发送结果。失败必须带可自助解决的原因，不要笼统报「失败」 */
export interface SendResult {
  ok: boolean
  reason?: string
}

/** 直播画面占位区矩形（CSS px，与 Electron DIP 一致） */
export interface VideoRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 抓取通道注册表：注入脚本 postMessage 的 `__LDA__` 标签 → 主进程 IPC 通道 + 单帧字节上限。
 * 新增平台只需在适配器的注入脚本里用一个新标签，并在这里登记一行即可，
 * preload 路由与主进程监听都是遍历本表，不必再逐个平台改代码。
 */
export const FRAME_CHANNELS: Record<string, { channel: string; maxBytes: number }> = {
  'ws-frame': { channel: 'wv:frame', maxBytes: 1024 * 1024 },
  'dy-frame': { channel: 'wv:dy-frame', maxBytes: 4 * 1024 * 1024 },
  'dy-body': { channel: 'wv:dy-body', maxBytes: 16 * 1024 * 1024 },
  'ks-frame': { channel: 'wv:ks-frame', maxBytes: 4 * 1024 * 1024 },
  'douyu-frame': { channel: 'wv:douyu-frame', maxBytes: 1024 * 1024 },
  'huya-frame': { channel: 'wv:huya-frame', maxBytes: 1024 * 1024 }
}

export type Emotion = 'answer' | 'thanks' | 'greet' | 'tease' | 'comfort'
export type ReplyStatus = 'pending-confirm' | 'queued' | 'sending' | 'sent' | 'failed' | 'rejected'
/**
 * 触发模式。
 * - `smart` / `all` / `question` / `keyword`：由弹幕**到达**驱动，逐条判断；
 * - `random`：**不看内容**，按随机时间间隔从最近弹幕池里挑一条回复（自动随机回复）。
 */
export type TriggerMode = 'smart' | 'keyword' | 'question' | 'all' | 'random'

export interface ReplyTask {
  id: string
  roomId: string
  replyTo: string
  text: string
  emotion: Emotion
  priority: 'high' | 'normal' | 'low'
  status: ReplyStatus
  reason?: string
  createdAt: number
  sentAt?: number
}

export interface HistoryDanmaku {
  id: string
  platform: Platform
  roomId: string
  type: DanmakuType
  uid: string
  nickname: string
  content: string
  source: CaptureSource
  ts: number
}

export interface HistoryReply {
  id: string
  roomId: string
  replyTo: string
  text: string
  emotion: string
  status: string
  createdAt: number
  sentAt: number | null
}

export interface HistoryQuery {
  roomId?: string
  keyword?: string
  limit?: number
  offset?: number
}

export interface HistoryResult<T> {
  /** 原生模块不可用（未针对 Electron ABI 重建）时为 false */
  available: boolean
  items: T[]
}

export type AiLogLevel = 'info' | 'warn' | 'error'

export interface AiLogEntry {
  level: AiLogLevel
  message: string
  nickname?: string
  ts: number
}

/** 回复链路当前状态，供 UI 提示「为什么没有回复」 */
export interface AiState {
  aiEnabled: boolean
  hasApiKey: boolean
  model: string
  dbAvailable: boolean
}

/** 设置项：主进程持久化，渲染进程经 IPC 读写，故定义在共享层 */
export interface AppSettings {
  glmBaseUrl: string
  glmModel: string
  glmApiKey: string
  persona: string
  triggerMode: TriggerMode
  keywords: string[]
  sensitiveWords: string[]
  requireConfirm: boolean
  maxPerMinute: number
  maxPerHour: number
  aiEnabled: boolean
  /** 相邻两条回复之间的最小间隔（秒）——防风控的节奏控制 */
  replyGapMinSec: number
  /** 相邻两条回复之间的最大间隔（秒）；实际间隔在 [min,max] 内随机 */
  replyGapMaxSec: number
  /** 「随机」触发模式下的最小间隔（秒） */
  randomIntervalMinSec: number
  /** 「随机」触发模式下的最大间隔（秒）；实际间隔在 [min,max] 内随机 */
  randomIntervalMaxSec: number
  /** 随机挑选回复对象时，从最近多少条弹幕里挑 */
  randomPoolSize: number
}

export interface ReplySnapshot {
  queue: ReplyTask[]
  history: ReplyTask[]
  sentLastMinute: number
  sentLastHour: number
}

/* --------------------------------------------------------------- 账号登录 */

/**
 * 登录态。抓取弹幕**不需要**登录（匿名直连即可收到弹幕），
 * 但发送弹幕必须登录：游客态页面根本不渲染输入框。
 */
export interface LoginState {
  isLogin: boolean
  uid?: number
  uname?: string
  /** 当前登录方式 */
  via?: 'cookie' | 'qr' | 'window'
  /** 缺失的关键 Cookie（如 bili_jct）：能收弹幕但发不出去 */
  missingCookies?: string[]
}

/** 扫码流程阶段 */
export type QrPhase = 'waiting-scan' | 'scanned' | 'confirmed' | 'expired' | 'error'

export interface QrSession {
  qrDataUrl: string
  key: string
  expiresAt: number
}

export interface PlatformAccount {
  id: string
  uname: string
  savedAt: number
}

/** 某平台的账号管理快照：登录态 + 已保存账号列表 + 当前激活 */
export interface PlatformAccountSnapshot {
  platform: Platform
  isLogin: boolean
  uname?: string
  uid?: string
  /** 缺失的关键 Cookie（B 站 bili_jct）：能收弹幕但发不出去 */
  missingCookies?: string[]
  accounts: PlatformAccount[]
  activeId: string | null
}

export interface ExportResult {
  ok: boolean
  path?: string
  count?: number
  error?: string
}

export interface QrPollResult {
  phase: QrPhase
  message?: string
  state?: LoginState
}
