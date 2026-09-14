import type { CaptureSource, DanmakuMessage, DanmakuType } from '../../../shared/types'

let seq = 0

/**
 * 斗鱼 STT 报文 → 统一弹幕结构。
 * 字段名取自斗鱼第三方接入协议：chatmsg(弹幕) / uenter(进房) / dgb(礼物)。
 * 未识别的 type（心跳 mrkl、登录响应、榜单等）返回 null。
 */
export function mapDouyuMessage(
  fields: Record<string, string>,
  roomId: string,
  source: CaptureSource = 'ws'
): DanmakuMessage | null {
  const kind = fields['type']
  if (!kind) return null

  const uid = fields['uid'] ?? ''
  const nickname = fields['nn'] || '未知用户'
  const medal = Number(fields['bl'] ?? 0)
  const avatar = fields['ic']
  const user: DanmakuMessage['user'] = {
    uid,
    nickname,
    ...(avatar ? { avatar } : {}),
    ...(medal > 0 ? { medalLevel: medal } : {})
  }

  if (kind === 'chatmsg') {
    const content = fields['txt'] ?? ''
    if (!content) return null
    return make('chat', roomId, user, content, source)
  }

  if (kind === 'uenter') {
    return make('enter', roomId, user, '', source)
  }

  if (kind === 'dgb') {
    const giftId = fields['gfid'] ?? '0'
    const count = Number(fields['gfcnt'] ?? 1) || 1
    return make('gift', roomId, user, `礼物#${giftId}`, source, {
      // dgb 报文只有礼物 id 与数量，没有名称与单价；不臆造数值
      gift: { name: `礼物#${giftId}`, count, price: 0 }
    })
  }

  return null
}

function make(
  type: DanmakuType,
  roomId: string,
  user: DanmakuMessage['user'],
  content: string,
  source: CaptureSource,
  extra: Partial<DanmakuMessage> = {}
): DanmakuMessage {
  seq = (seq + 1) % 1_000_000
  return {
    id: `douyu:${roomId}:${user.uid || '0'}:${type}:${Date.now()}:${seq}`,
    platform: 'douyu',
    roomId,
    type,
    user,
    content,
    ts: Date.now(),
    source,
    ...extra
  }
}
