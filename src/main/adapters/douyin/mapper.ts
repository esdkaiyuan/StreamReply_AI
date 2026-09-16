import type { CaptureSource, DanmakuMessage, DanmakuType } from '../../../shared/types'
import { asBigString, asMessage, asNumber, asString, decodeMessage, type ProtoMessage } from '../protobuf'

/** 抖币 → 元按 10:1 估算（抖音充值比例随档位浮动，此处仅作展示参考） */
const COIN_PER_YUAN = 10

let seq = 0

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

interface DouyinUserInfo {
  uid: string
  nickname: string
  avatar?: string
}

function readUser(user: ProtoMessage | null): DouyinUserInfo {
  if (!user) return { uid: '0', nickname: '未知用户' }
  const nickname = asString(user, 3) || '未知用户'
  const uid = asString(user, 1028) || asBigString(user, 1) || '0'
  const avatarMsg = asMessage(user, 9)
  const firstUrl = avatarMsg?.get(1)?.[0]?.data.toString('utf8')
  return firstUrl ? { uid, nickname, avatar: firstUrl } : { uid, nickname }
}

function build(
  type: DanmakuType,
  user: ProtoMessage | null,
  roomId: string,
  content: string,
  source: CaptureSource,
  extra: Partial<DanmakuMessage> = {}
): DanmakuMessage {
  const info = readUser(user)
  const ts = Date.now()
  seq = (seq + 1) % 1_000_000
  return {
    id: `douyin:${roomId}:${ts}:${hash(content)}:${seq}`,
    platform: 'douyin',
    roomId,
    type,
    user: info.avatar
      ? { uid: info.uid, nickname: info.nickname, avatar: info.avatar }
      : { uid: info.uid, nickname: info.nickname },
    content,
    ts,
    source,
    ...extra
  }
}

/**
 * 抖音 IM 消息 → 统一弹幕结构。
 * 字段号取自公开的 douyin.proto 定义；未识别的 method 返回 null。
 * 注：房间统计（在线人数）暂未接入，需真实环境确认对应 method 后再补。
 */
export function mapDouyinMessage(
  method: string,
  payload: Buffer,
  roomId: string,
  source: CaptureSource = 'ws'
): DanmakuMessage | null {
  if (!payload || payload.length === 0) return null
  const msg = decodeMessage(payload)

  switch (method) {
    case 'WebcastChatMessage': {
      const content = asString(msg, 3)
      if (!content) return null
      return build('chat', asMessage(msg, 2), roomId, content, source)
    }

    case 'WebcastGiftMessage': {
      const gift = asMessage(msg, 15)
      const name = gift ? asString(gift, 16) : ''
      const count = Math.max(asNumber(msg, 5), 1)
      const diamond = gift ? asNumber(gift, 12) : 0
      return build('gift', asMessage(msg, 7), roomId, name || '礼物', source, {
        gift: { name: name || '礼物', count, price: diamond / COIN_PER_YUAN }
      })
    }

    case 'WebcastMemberMessage':
      return build('enter', asMessage(msg, 2), roomId, '', source)

    case 'WebcastLikeMessage': {
      const count = Math.max(asNumber(msg, 2), 1)
      return build('like', asMessage(msg, 5), roomId, `点赞 ×${count}`, source)
    }

    case 'WebcastSocialMessage':
      return build('follow', asMessage(msg, 2), roomId, '', source)

    default:
      return null
  }
}

/**
 * 在线人数。
 *
 * 抖音把它放在 **`WebcastRoomUserSeqMessage`**（`total` 字段号 3，int64）——
 * 与弹幕共用同一条 IM 通道，所以解析帧时顺路取出即可，不必额外发请求。
 *
 * 取值失败一律返回 `undefined`：宁可 UI 不显示人数，也不能显示一个错的数字。
 * ⚠️ 字段号取自公开 `douyin.proto`，**尚未在真实直播间核对**；
 * 联调时若人数明显不对，先回来查这里的 method 名与字段号。
 */
export function readDouyinOnlineCount(method: string, payload: Buffer): number | undefined {
  if (method !== 'WebcastRoomUserSeqMessage') return undefined
  try {
    const msg = decodeMessage(payload)
    // ⚠️ 必须先判字段存在：asNumber 对**缺失字段**返回 0，与「在线人数真的是 0」无法区分，
    // 直接用会把空 payload 变成「0 人在线」这种假数据。
    if (!msg.get(3)?.length) return undefined
    const total = asNumber(msg, 3)
    if (Number.isFinite(total) && total >= 0) return Math.floor(total)
  } catch {
    /* 坏帧忽略，不影响同帧里的其它消息 */
  }
  return undefined
}
