import { gzipSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { kuaishouAdapter } from '../src/main/adapters/kuaishou'
import { KS_PAYLOAD, parseDisplayCount, parseSocketMessage } from '../src/main/adapters/kuaishou/frame'
import { mapKuaishouFeedPush } from '../src/main/adapters/kuaishou/mapper'
import type { DanmakuMessage } from '../src/shared/types'
import { bytes, msg, num, text } from './proto-enc'

/** SimpleUserInfo { principalId=1, userName=2, headUrl=3 } */
function simpleUser(uid: string, nick: string, head = ''): number[] {
  return [...text(1, uid), ...text(2, nick), ...(head ? text(3, head) : [])]
}

/** WebCommentFeed { id=1, user=2, content=3 } */
function commentFeed(id: string, uid: string, nick: string, content: string): number[] {
  return [...text(1, id), ...msg(2, simpleUser(uid, nick)), ...text(3, content)]
}

/** SCWebFeedPush { displayWatchingCount=1, commentFeeds=5, ... }；parts 为各字段字节 */
function feedPush(parts: number[][], watching = ''): number[] {
  return [...(watching ? text(1, watching) : []), ...parts.flat()]
}

/** SocketMessage { payloadType=1, compressionType=2, payload=3 } */
function socketMessage(payloadType: number, payload: number[], compression: number): Buffer {
  const body = [...num(1, payloadType), ...num(2, compression), ...bytes(3, payload)]
  return Buffer.from(body)
}

describe('kuaishou socket message', () => {
  it('解析未压缩帧', () => {
    const raw = socketMessage(KS_PAYLOAD.SC_FEED_PUSH, feedPush([msg(5, [])]), 1)
    const parsed = parseSocketMessage(raw)
    expect(parsed?.payloadType).toBe(310)
    expect(parsed?.compressionType).toBe(1)
  })

  it('compressionType=GZIP 时自动解压 payload', () => {
    const inner = feedPush([msg(5, commentFeed('c1', 'u1', '小明', '主播好'))])
    const gz = [...gzipSync(Buffer.from(inner))]
    const parsed = parseSocketMessage(socketMessage(310, gz, 2))
    expect(parsed).not.toBeNull()
    expect(mapKuaishouFeedPush(parsed!.payload, 'R1').danmaku).toHaveLength(1)
  })

  it('AES 压缩明确返回 null，不产出垃圾', () => {
    expect(parseSocketMessage(socketMessage(310, [1, 2, 3], 3))).toBeNull()
  })

  it('缺 payload 或坏帧返回 null', () => {
    expect(parseSocketMessage(Buffer.alloc(0))).toBeNull()
    expect(parseSocketMessage(Buffer.from([0xff, 0xff, 0xff]))).toBeNull()
  })
})

describe('displayCount 解析', () => {
  it('纯数字 / 万 / 亿', () => {
    expect(parseDisplayCount('4772')).toBe(4772)
    expect(parseDisplayCount('1.2万')).toBe(12000)
    expect(parseDisplayCount('3.4亿')).toBe(340000000)
  })

  it('空值与非数字返回 undefined', () => {
    expect(parseDisplayCount('')).toBeUndefined()
    expect(parseDisplayCount('  ')).toBeUndefined()
    expect(parseDisplayCount('很多')).toBeUndefined()
  })
})

describe('kuaishou feed push 映射', () => {
  const roomId = 'R1'
  const asDanmaku = (v: DanmakuMessage[]): DanmakuMessage[] => v

  it('commentFeeds → chat（含昵称/头像/在线人数）', () => {
    const payload = Buffer.from(
      feedPush([msg(5, commentFeed('c1', 'u1', '小明', '主播好'))], '1.2万')
    )
    const res = mapKuaishouFeedPush(payload, roomId)
    expect(res.danmaku).toHaveLength(1)
    const first = asDanmaku(res.danmaku)[0]
    expect(first.type).toBe('chat')
    expect(first.content).toBe('主播好')
    expect(first.user.nickname).toBe('小明')
    expect(first.user.uid).toBe('u1')
    expect(first.platform).toBe('kuaishou')
    expect(res.onlineCount).toBe(12000)
  })

  it('giftFeeds → gift（礼物名仅能给出 ID，不臆造名称）', () => {
    const giftFeed = [...text(1, 'g1'), ...msg(2, simpleUser('u2', '土豪')), ...num(4, 555), ...num(7, 3)]
    const res = mapKuaishouFeedPush(Buffer.from(feedPush([msg(9, giftFeed)])), roomId)
    const gift = asDanmaku(res.danmaku)[0]
    expect(gift.type).toBe('gift')
    expect(gift.gift?.count).toBe(3)
    expect(gift.gift?.name).toBe('礼物#555')
    expect(gift.user.nickname).toBe('土豪')
  })

  it('likeFeeds / shareFeeds / comboCommentFeeds 分别映射', () => {
    const likeFeed = [...text(1, 'l1'), ...msg(2, simpleUser('u3', '点赞的'))]
    const shareFeed = [...text(1, 's1'), ...msg(2, simpleUser('u4', '分享的'))]
    const comboFeed = [...text(1, 'k1'), ...text(2, '哈哈哈'), ...num(3, 5)]
    const res = mapKuaishouFeedPush(
      Buffer.from(feedPush([msg(8, likeFeed), msg(12, shareFeed), msg(7, comboFeed)])),
      roomId
    )
    const types = res.danmaku.map((d) => d.type)
    expect(types).toContain('like')
    expect(types).toContain('share')
    expect(res.danmaku.some((d) => d.content === '哈哈哈 ×5')).toBe(true)
  })

  it('空 payload 与空 feed 列表安全返回', () => {
    expect(mapKuaishouFeedPush(Buffer.alloc(0), roomId).danmaku).toEqual([])
    expect(mapKuaishouFeedPush(Buffer.from([]), roomId).danmaku).toEqual([])
  })
})

describe('kuaishou adapter', () => {
  it('URL / WS 判定 / 房间号 / 发送脚本', () => {
    expect(kuaishouAdapter.roomUrl('3xabc')).toBe('https://live.kuaishou.com/u/3xabc')
    expect(kuaishouAdapter.parseRoomId('https://live.kuaishou.com/u/3xabc')).toBe('3xabc')
    expect(kuaishouAdapter.isDanmakuWs('wss://live-ws-pc.kuaishou.com/websocket')).toBe(true)
    expect(kuaishouAdapter.isDanmakuWs('wss://broadcastlv.chat.bilibili.com/sub')).toBe(false)
    expect(kuaishouAdapter.domFallbackScript()).toBeNull()
    expect(kuaishouAdapter.sendScript('你好')).toContain('"你好"')
  })

  it('非 310 的 payloadType 不产出弹幕', () => {
    const raw = socketMessage(KS_PAYLOAD.SC_HEARTBEAT_ACK, [...num(1, 123)], 1)
    expect(kuaishouAdapter.parseFrame(raw, 'R1', 'ws').danmaku).toEqual([])
  })

  it('完整 gzip 帧解析为弹幕（端到端）', () => {
    const inner = feedPush([msg(5, commentFeed('c9', 'u9', '端到端', '跑通了'))])
    const raw = socketMessage(310, [...gzipSync(Buffer.from(inner))], 2)
    const result = kuaishouAdapter.parseFrame(raw, 'R1', 'ws')
    expect(result.danmaku).toHaveLength(1)
    expect(result.danmaku[0].content).toBe('跑通了')
  })
})
