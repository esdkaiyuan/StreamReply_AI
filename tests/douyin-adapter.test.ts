import { gzipSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { parsePushFrame } from '../src/main/adapters/douyin/frame'
import { mapDouyinMessage } from '../src/main/adapters/douyin/mapper'
import type { DanmakuMessage } from '../src/shared/types'
import { bytes, msg, num, tag, text, varintBig } from './proto-enc'

/** 构造一个 IM Message：method(1) + payload(2) */
function imMessage(method: string, payload: number[]): number[] {
  return [...text(1, method), ...bytes(2, payload)]
}

/** 构造 PushFrame：payload(8) 为 gzip 后的 Response */
function pushFrame(messages: number[][]): Buffer {
  const response = messages.flatMap((m) => msg(1, m))
  return Buffer.from(msg(8, [...gzipSync(Buffer.from(response))]))
}

/** ChatMessage: common(1){roomId=3} user(2){id,nickName} content(3) */
function chatPayload(nick: string, content: string, uid = 12345): number[] {
  const common = num(3, 7001)
  const user = [...tag(1, 0), ...varintBig(BigInt(uid)), ...text(3, nick)]
  return [...msg(1, common), ...msg(2, user), ...text(3, content)]
}

function asDanmaku(v: DanmakuMessage | null): DanmakuMessage {
  expect(v).not.toBeNull()
  return v as DanmakuMessage
}

describe('douyin frame', () => {
  it('解析 PushFrame → gunzip → Response.messagesList', () => {
    const frame = pushFrame([
      imMessage('WebcastChatMessage', chatPayload('小明', '主播好')),
      imMessage('WebcastLikeMessage', [...num(2, 3)])
    ])
    const list = parsePushFrame(frame)
    expect(list.map((m) => m.method)).toEqual(['WebcastChatMessage', 'WebcastLikeMessage'])
    expect(list[0].payload.length).toBeGreaterThan(0)
  })

  it('非 gzip 的 payload 走 zlib 兜底不崩', () => {
    const raw = Buffer.from(msg(8, msg(1, imMessage('WebcastChatMessage', chatPayload('a', 'b')))))
    expect(() => parsePushFrame(raw)).not.toThrow()
  })

  it('坏帧返回空数组', () => {
    expect(parsePushFrame(Buffer.alloc(0))).toEqual([])
    expect(parsePushFrame(Buffer.from([0xff, 0xff, 0xff]))).toEqual([])
  })
})

describe('douyin mapper', () => {
  const roomId = '7001'

  it('ChatMessage → chat', () => {
    const m = asDanmaku(
      mapDouyinMessage('WebcastChatMessage', Buffer.from(chatPayload('小明', '主播好')), roomId)
    )
    expect(m.type).toBe('chat')
    expect(m.content).toBe('主播好')
    expect(m.user.nickname).toBe('小明')
    expect(m.user.uid).toBe('12345')
    expect(m.platform).toBe('douyin')
    expect(m.roomId).toBe(roomId)
    expect(m.source).toBe('ws')
  })

  it('GiftMessage → gift（含礼物名与数量）', () => {
    const giftStruct = [...text(16, '小心心'), ...num(12, 1)]
    const payload = [
      ...msg(1, num(3, 7001)),
      ...num(2, 555),
      ...num(5, 10),
      ...msg(7, [...text(3, '土豪')]),
      ...msg(15, giftStruct)
    ]
    const m = asDanmaku(mapDouyinMessage('WebcastGiftMessage', Buffer.from(payload), roomId))
    expect(m.type).toBe('gift')
    expect(m.gift?.name).toBe('小心心')
    expect(m.gift?.count).toBe(10)
    expect(m.gift?.price).toBeCloseTo(0.1)
    expect(m.user.nickname).toBe('土豪')
  })

  it('MemberMessage → enter', () => {
    const payload = [...msg(1, num(3, 7001)), ...msg(2, [...text(3, '新观众')]), ...num(3, 88)]
    const m = asDanmaku(mapDouyinMessage('WebcastMemberMessage', Buffer.from(payload), roomId))
    expect(m.type).toBe('enter')
    expect(m.user.nickname).toBe('新观众')
  })

  it('LikeMessage → like', () => {
    const payload = [...num(2, 5), ...num(3, 100), ...msg(5, [...text(3, '点赞的')])]
    const m = asDanmaku(mapDouyinMessage('WebcastLikeMessage', Buffer.from(payload), roomId))
    expect(m.type).toBe('like')
    expect(m.user.nickname).toBe('点赞的')
  })

  it('SocialMessage → follow', () => {
    const payload = [...msg(2, [...text(3, '关注的')]), ...num(4, 1)]
    const m = asDanmaku(mapDouyinMessage('WebcastSocialMessage', Buffer.from(payload), roomId))
    expect(m.type).toBe('follow')
    expect(m.user.nickname).toBe('关注的')
  })

  it('未知 method 与空 payload 返回 null', () => {
    expect(mapDouyinMessage('WebcastUnknownMessage', Buffer.from([...num(1, 1)]), roomId)).toBeNull()
    expect(mapDouyinMessage('WebcastChatMessage', Buffer.alloc(0), roomId)).toBeNull()
  })
})
