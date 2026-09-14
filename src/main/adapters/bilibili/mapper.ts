import type { CaptureSource, DanmakuMessage, RoomStatEvent } from '../../../shared/types'

export type MappedEvent = DanmakuMessage | RoomStatEvent | null

let seq = 0

function makeId(roomId: string, uid: string, kind: string): string {
  seq = (seq + 1) % 1_000_000
  return `bili:${roomId}:${uid}:${kind}:${Date.now()}:${seq}`
}

/**
 * 将一条 B 站弹幕 WS 的 JSON 事件映射为统一结构。
 * DANMU_MSG 的 payload 是 info 数组，其余 cmd 的 payload 是 { cmd, data } 中的 data 对象。
 */
export function mapBilibiliEvent(
  cmd: string,
  payload: unknown,
  roomId: string,
  source: CaptureSource
): MappedEvent {
  const ts = Date.now()
  const base = { platform: 'bilibili' as const, roomId, ts, source }

  if (cmd.startsWith('DANMU_MSG')) {
    // 真实 WS 事件是 { cmd, info: [...] }，而单测直接传 info 数组，两种形态都要兼容
    const info = (Array.isArray(payload) ? payload : (payload as { info?: unknown[] })?.info ?? []) as unknown[]
    const content = String(info?.[1] ?? '')
    const u = (info?.[2] ?? []) as unknown[]
    const medal = (info?.[3] ?? []) as unknown[]
    return {
      ...base,
      id: makeId(roomId, String(u?.[0] ?? ''), 'chat'),
      type: 'chat',
      user: {
        uid: String(u?.[0] ?? ''),
        nickname: String(u?.[1] ?? '未知用户'),
        avatar: u?.[2] ? String(u[2]) : undefined,
        medalLevel: Number(medal?.[1] ?? 0) || undefined
      },
      content
    }
  }

  const data = (payload as { data?: Record<string, unknown> })?.data ?? {}

  switch (cmd) {
    case 'INTERACT_WORD':
      return {
        ...base,
        id: makeId(roomId, String(data['uid'] ?? ''), 'enter'),
        type: 'enter',
        user: { uid: String(data['uid'] ?? ''), nickname: String(data['uname'] ?? '') },
        content: ''
      }
    case 'SEND_GIFT': {
      const price = Number(data['price'] ?? 0) // 单位：金瓜子（1 元 = 1000 瓜子）
      return {
        ...base,
        id: makeId(roomId, String(data['uid'] ?? ''), 'gift'),
        type: 'gift',
        user: {
          uid: String(data['uid'] ?? ''),
          nickname: String(data['uname'] ?? ''),
          avatar: data['face'] ? String(data['face']) : undefined
        },
        content: '',
        gift: {
          name: String(data['giftName'] ?? ''),
          count: Number(data['num'] ?? 1),
          price: price / 1000
        }
      }
    }
    case 'GUARD_BUY':
      return {
        ...base,
        id: makeId(roomId, String(data['uid'] ?? ''), 'gift'),
        type: 'gift',
        user: { uid: String(data['uid'] ?? ''), nickname: String(data['username'] ?? '') },
        content: '',
        gift: { name: String(data['gift_name'] ?? '舰长'), count: Number(data['num'] ?? 1), price: Number(data['price'] ?? 0) / 1000 }
      }
    case 'WATCHED_CHANGE':
      return {
        platform: 'bilibili',
        roomId,
        onlineCount: Number(data['num'] ?? 0),
        danmakuRate: -1, // 由总线填充本地统计
        ts
      }
    default:
      return null
  }
}
