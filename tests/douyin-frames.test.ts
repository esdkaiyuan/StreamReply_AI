import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { douyinAdapter } from '../src/main/adapters/douyin'
import { parsePushFrame } from '../src/main/adapters/douyin/frame'

interface FixtureFrame {
  dir: 'recv' | 'sent'
  len: number
  hex: string
  note?: string
}
const fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'douyin-frames.json'), 'utf8')
) as { note: string; frames: FixtureFrame[] }

const frames = fixtures.frames.map((f) => ({ ...f, buf: Buffer.from(f.hex, 'hex') }))
const ROOM = '229768826112'

/**
 * ⚠️ 抖音的一帧 IM 常常**混合多种消息**（如 Chat + Like + Member），
 * 断言一律用「存在性」而不是「every」，也不要假设某帧只有一种类型。
 * 另：enter（进场）消息的 content 本来就是空的 —— 非空断言只对 chat 生效。
 */
describe('抖音真实帧夹具（2026-09-17 从 live.douyin.com 抓取）', () => {
  it('夹具完好（长度与 hex 一致，覆盖弹幕/人数/点赞/进场）', () => {
    expect(frames.length).toBeGreaterThanOrEqual(8)
    for (const f of frames) expect(f.buf.length).toBe(f.len)
    for (const note of ['弹幕', '在线人数', '点赞', '进场']) {
      expect(frames.some((f) => f.note === note)).toBe(true)
    }
  })

  it('真实弹幕帧解出 chat 消息，昵称与内容均为可读文本', () => {
    const chats = frames
      .flatMap((f) => douyinAdapter.parseFrame(f.buf, ROOM, 'ws').danmaku)
      .filter((m) => m.type === 'chat')
    expect(chats.length).toBeGreaterThan(0)
    for (const msg of chats) {
      expect(msg.platform).toBe('douyin')
      expect(msg.roomId).toBe(ROOM)
      expect(msg.content.trim().length).toBeGreaterThan(0)
      expect(msg.user.nickname.trim().length).toBeGreaterThan(0)
      expect(msg.content).not.toContain('\ufffd')
      expect(msg.user.nickname).not.toContain('\ufffd')
    }
  })

  it('解出的确实是观众发言（如「700万的椅子在哪呢」）', () => {
    const chats = frames
      .flatMap((f) => douyinAdapter.parseFrame(f.buf, ROOM, 'ws').danmaku)
      .filter((m) => m.type === 'chat')
    // 真实房间存在刷屏句（多人发同一句），取一句断言至少被 2 个不同昵称发出
    const byContent = new Map<string, Set<string>>()
    for (const m of chats) {
      const set = byContent.get(m.content) ?? new Set<string>()
      set.add(m.user.nickname)
      byContent.set(m.content, set)
    }
    expect([...byContent.values()].some((s) => s.size >= 2)).toBe(true)
  })

  it('在线人数帧解出正整数（WebcastRoomUserSeqMessage.total）', () => {
    const stat = frames.filter((f) => f.note === '在线人数')
    expect(stat.length).toBeGreaterThan(0)
    for (const f of stat) {
      const result = douyinAdapter.parseFrame(f.buf, ROOM, 'ws')
      expect(result.onlineCount).toBeDefined()
      expect(result.onlineCount!).toBeGreaterThan(0)
    }
  })

  it('点赞与进场消息类型正确，不产出 chat 弹幕', () => {
    const like = frames.find((f) => f.note === '点赞')!
    const enter = frames.find((f) => f.note === '进场')!
    const likeMsgs = douyinAdapter.parseFrame(like.buf, ROOM, 'ws').danmaku
    const enterMsgs = douyinAdapter.parseFrame(enter.buf, ROOM, 'ws').danmaku
    expect(likeMsgs.some((m) => m.type === 'like')).toBe(true)
    expect(enterMsgs.some((m) => m.type === 'enter')).toBe(true)
    // 点赞/进场帧即使混有其它消息，也不该把非 chat 内容当成弹幕
    expect(likeMsgs.every((m) => m.type !== 'chat')).toBe(true)
    expect(enterMsgs.every((m) => m.type !== 'chat')).toBe(true)
  })

  it('解析任何帧都不抛异常（坏帧安全）', () => {
    for (const f of frames) {
      expect(() => douyinAdapter.parseFrame(f.buf, ROOM, 'ws')).not.toThrow()
    }
  })
})

describe('抖音抓取通道与端点判定（真实环境确认）', () => {
  it('抖音走 CDP 抓帧', () => {
    expect(douyinAdapter.captureViaCdp).toBe(true)
  })

  it('识别实测到的弹幕端点（webcast*-ws-web-*.douyin.com/webcast/im/push/v2）', () => {
    expect(
      douyinAdapter.isDanmakuWs(
        'wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/?app_name=douyin_web&version_code=180800'
      )
    ).toBe(true)
    // 环控/埋点连接不应被当成弹幕
    expect(douyinAdapter.isDanmakuWs('wss://mon.zijieapi.com/monitor_browser/collect')).toBe(false)
  })
})

describe('抖音帧内消息谱系（真实分布，用于回归）', () => {
  it('夹具帧中能找到 Chat / Like / Member / RoomUserSeq 四类 method', () => {
    const methods = new Set<string>()
    for (const f of frames) {
      for (const m of parsePushFrame(f.buf)) methods.add(m.method)
    }
    for (const expected of [
      'WebcastChatMessage',
      'WebcastLikeMessage',
      'WebcastMemberMessage',
      'WebcastRoomUserSeqMessage'
    ]) {
      expect(methods.has(expected)).toBe(true)
    }
  })
})
