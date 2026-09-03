export type Platform = 'bilibili' | 'douyin' | 'kuaishou'
export type DanmakuType = 'chat' | 'enter' | 'gift' | 'like' | 'follow' | 'share'
export type CaptureSource = 'ws' | 'dom'
export type RoomStatus = 'idle' | 'loading' | 'connected' | 'fallback-dom' | 'error' | 'closed'

export interface DanmakuUser {
  uid: string
  nickname: string
  avatar?: string
  guardLevel?: number
}

export interface GiftInfo { name: string; count: number; price: number }

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
  wvSendText: 'wv:send-text'
} as const

export interface AddRoomResult { ok: boolean; error?: string }
