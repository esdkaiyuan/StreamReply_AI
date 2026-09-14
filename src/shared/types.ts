export type Platform = 'bilibili' | 'douyin' | 'kuaishou'
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
  historyReplies: 'history:replies',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set'
} as const

export interface AddRoomResult { ok: boolean; error?: string }

export type Emotion = 'answer' | 'thanks' | 'greet' | 'tease' | 'comfort'
export type ReplyStatus = 'pending-confirm' | 'queued' | 'sending' | 'sent' | 'failed' | 'rejected'
export type TriggerMode = 'smart' | 'keyword' | 'question' | 'all'

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
}

export interface ReplySnapshot {
  queue: ReplyTask[]
  history: ReplyTask[]
  sentLastMinute: number
  sentLastHour: number
}
