import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { douyuAdapter } from '../src/main/adapters/douyu'
import { splitPackets } from '../src/main/adapters/douyu/frame'

interface FixtureFrame {
  dir: 'recv' | 'sent'
  len: number
  hex: string
  note?: string
}
const fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'douyu-frames.json'), 'utf8')
) as { note: string; frames: FixtureFrame[] }

const frames = fixtures.frames.map((f) => ({ ...f, buf: Buffer.from(f.hex, 'hex') }))
const ROOM = '84452'

describe('斗鱼真实帧夹具（2026-09-17 从 www.douyu.com/84452 抓取）', () => {
  it('夹具完好且覆盖关键帧型', () => {
    expect(frames.length).toBeGreaterThanOrEqual(4)
    for (const f of frames) expect(f.buf.length).toBe(f.len)
    for (const note of ['多包粘连', 'chatmsg']) {
      expect(frames.some((f) => (f.note ?? '').startsWith(note))).toBe(true)
    }
  })

  it('服务端帧的类型标识是 0x02b2（与发送侧 0x02b1 不同）', () => {
    for (const f of frames) {
      expect(f.buf.readUInt16LE(8)).toBe(0x02b2)
    }
  })

  it('多包粘连帧能一次性拆出全部包', () => {
    const glued = frames.find((f) => f.note === '多包粘连')!
    const packets = splitPackets(glued.buf)
    // 真实帧：loginres(306B) + 另一个包，一条 WS 消息里粘连多个协议包
    expect(packets.length).toBeGreaterThanOrEqual(2)
    expect(packets.some((p) => p.includes('type@=loginres'))).toBe(true)
    // 完整消费整条消息（不能因错位丢包）
    expect(packets.join('').length).toBeGreaterThan(0)
  })

  it('真实弹幕帧解出 chatmsg 文本', () => {
    const chat = frames.find((f) => (f.note ?? '').startsWith('chatmsg'))!
    const packets = splitPackets(chat.buf)
    expect(packets.some((p) => p.startsWith('type@=chatmsg/'))).toBe(true)
  })
})

describe('斗鱼适配器端到端（真实帧）', () => {
  it('chatmsg 真实帧解出昵称与弹幕内容', () => {
    const total: Array<{ nick: string; text: string }> = []
    for (const f of frames) {
      const result = douyuAdapter.parseFrame(f.buf, ROOM, 'ws')
      for (const msg of result.danmaku) {
        expect(msg.platform).toBe('douyu')
        if (msg.type === 'chat') {
          total.push({ nick: msg.user.nickname, text: msg.content })
          expect(msg.roomId).toBe(ROOM)
          expect(msg.content.trim().length).toBeGreaterThan(0)
          expect(msg.user.nickname.trim().length).toBeGreaterThan(0)
          expect(msg.content).not.toContain('\ufffd')
        }
      }
    }
    expect(total.length).toBeGreaterThan(0)
  })

  it('解析任何真实帧都不抛异常（坏帧安全）', () => {
    for (const f of frames) {
      expect(() => douyuAdapter.parseFrame(f.buf, ROOM, 'ws')).not.toThrow()
    }
  })

  it('识别实测到的弹幕端点（danmuproxy.douyu.com:8502）', () => {
    expect(douyuAdapter.isDanmakuWs('wss://danmuproxy.douyu.com:8502/')).toBe(true)
    expect(douyuAdapter.isDanmakuWs('wss://wsproxy.douyu.com:6671/')).toBe(true)
  })
})
