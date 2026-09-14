import type { CaptureSource, DanmakuMessage } from '../../../shared/types'
import { HUYA_URI } from './frame'
import { decodeStruct, intOf, strOf, structOf } from './jce'

export type HuyaMapped =
  | { kind: 'danmaku'; message: DanmakuMessage }
  | { kind: 'online'; count: number }
  | null

let seq = 0

/**
 * 虎牙消息体 → 统一结构。
 *
 * HYMessage { 0: UserInfo(HYSender), 3: Content, 6: BulletFormat }
 * HYSender { 0: Uid, 1: Lmid, 2: NickName, 3: Gender }
 * 8006（在线人气）的消息体是单个 LONG。
 */
export function mapHuyaMessage(
  uri: number,
  body: Buffer,
  roomId: string,
  source: CaptureSource = 'ws'
): HuyaMapped {
  if (uri === HUYA_URI.ONLINE) {
    const fields = decodeStruct(body)
    return fields ? { kind: 'online', count: intOf(fields, 0) } : null
  }

  if (uri !== HUYA_URI.CHAT) return null

  const message = decodeStruct(body)
  if (!message) return null
  const content = strOf(message, 3)
  if (!content) return null

  const sender = structOf(message, 0)
  const uid = sender ? intOf(sender, 0) : 0
  const nickname = (sender ? strOf(sender, 2) : '') || '未知用户'

  seq = (seq + 1) % 1_000_000
  return {
    kind: 'danmaku',
    message: {
      id: `huya:${roomId}:${uid}:chat:${Date.now()}:${seq}`,
      platform: 'huya',
      roomId,
      type: 'chat',
      user: { uid: String(uid), nickname },
      content,
      ts: Date.now(),
      source
    }
  }
}
