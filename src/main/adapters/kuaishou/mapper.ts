import type { CaptureSource, DanmakuMessage, DanmakuType } from '../../../shared/types'
import { asMessage, asNumber, asString, decodeMessage, type ProtoMessage } from '../protobuf'
import { parseDisplayCount } from './frame'

let seq = 0

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

interface FeedUser {
  uid: string
  nickname: string
  avatar?: string
}

/** SimpleUserInfo { principalId=1, userName=2, headUrl=3 }；comboCommentFeed 无用户字段 */
function readUser(feed: ProtoMessage, userField: number): FeedUser {
  const user = userField > 0 ? asMessage(feed, userField) : null
  if (!user) return { uid: '0', nickname: '未知用户' }
  const nickname = asString(user, 2) || '未知用户'
  const uid = asString(user, 1) || '0'
  const head = asString(user, 3)
  return head ? { uid, nickname, avatar: head } : { uid, nickname }
}

function build(
  feed: ProtoMessage,
  userField: number,
  type: DanmakuType,
  roomId: string,
  content: string,
  source: CaptureSource,
  extra: Partial<DanmakuMessage> = {}
): DanmakuMessage {
  const info = readUser(feed, userField)
  const ts = Date.now()
  seq = (seq + 1) % 1_000_000
  return {
    id: `ks:${roomId}:${asString(feed, 1) || ts}:${hash(content)}:${seq}`,
    platform: 'kuaishou',
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

export interface KuaishouFeedResult {
  danmaku: DanmakuMessage[]
  onlineCount?: number
}

/**
 * SCWebFeedPush（payloadType=310）→ 逐类 feed 映射为统一弹幕。
 *
 * 字段号取自公开协议定义：
 * displayWatchingCount=1(字符串) / commentFeeds=5 / comboCommentFeed=7 /
 * likeFeeds=8 / giftFeeds=9 / shareFeeds=12。
 * systemNoticeFeeds(11) 是系统公告而非用户弹幕，刻意跳过。
 */
export function mapKuaishouFeedPush(
  payload: Buffer,
  roomId: string,
  source: CaptureSource = 'ws'
): KuaishouFeedResult {
  if (payload.length === 0) return { danmaku: [] }
  const push = decodeMessage(payload)
  const danmaku: DanmakuMessage[] = []

  const eachFeed = (field: number, handle: (feed: ProtoMessage) => void): void => {
    for (const item of push.get(field) ?? []) {
      if (item.wire === 2) handle(decodeMessage(item.data))
    }
  }

  eachFeed(5, (feed) => {
    const content = asString(feed, 3)
    if (content) danmaku.push(build(feed, 2, 'chat', roomId, content, source))
  })

  eachFeed(7, (feed) => {
    const content = asString(feed, 2)
    const combo = Math.max(asNumber(feed, 3), 1)
    if (content) danmaku.push(build(feed, 0, 'chat', roomId, `${content} ×${combo}`, source))
  })

  eachFeed(8, (feed) => {
    danmaku.push(build(feed, 2, 'like', roomId, '点赞', source))
  })

  eachFeed(9, (feed) => {
    const giftId = asNumber(feed, 4)
    const count = Math.max(asNumber(feed, 7), 1) // batchSize：本批礼物数量
    danmaku.push(
      build(feed, 2, 'gift', roomId, `礼物#${giftId}`, source, {
        // feed 里不含礼物名与单价，需另查礼物接口；只填能确认的部分，不臆造
        gift: { name: `礼物#${giftId}`, count, price: 0 }
      })
    )
  })

  eachFeed(12, (feed) => {
    danmaku.push(build(feed, 2, 'share', roomId, '', source))
  })

  const onlineCount = parseDisplayCount(asString(push, 1))
  return onlineCount === undefined ? { danmaku } : { danmaku, onlineCount }
}
