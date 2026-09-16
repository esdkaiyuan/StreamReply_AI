import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { huyaAdapter } from '../src/main/adapters/huya'
import { parseHuyaFrame } from '../src/main/adapters/huya/frame'

interface FixtureFrame {
  dir: 'recv' | 'sent'
  len: number
  hex: string
}
const fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'huya-frames.json'), 'utf8')
) as { note: string; frames: FixtureFrame[] }

const frames = fixtures.frames.map((f) => ({ ...f, buf: Buffer.from(f.hex, 'hex') }))

describe('虎牙真实帧夹具（2026-09-17 从 live.huya.com/lpl 抓取）', () => {
  it('夹具本身完好（长度与 hex 一致）', () => {
    expect(frames.length).toBeGreaterThanOrEqual(4)
    for (const f of frames) expect(f.buf.length).toBe(f.len)
  })

  it('WUP 信封特征：偏移 2 处是 0x1D（低半字节 = 标准类型表之外的类型 13）', () => {
    // 这是本平台抓取失效的根因：读取器遇到未知类型即中断
    for (const f of frames) {
      expect(f.buf.length).toBeGreaterThan(3)
      expect(f.buf[2]).toBe(0x1d)
    }
  })

  it('发送帧里能看到 WUP 的结构特征字符串（launch / wsLaunch / tReq）', () => {
    const sent = frames.filter((f) => f.dir === 'sent')
    const text = sent.map((f) => f.buf.toString('latin1')).join('|')
    expect(text).toContain('launch')
    expect(text).toContain('wsLaunch')
    expect(text).toContain('tReq')
  })

  it('当前读取器解不出这些真实帧 —— 明确记录为已知缺陷，修好后此用例应改为断言能解出 Uri', () => {
    const produced = frames.flatMap((f) => parseHuyaFrame(f.buf))
    expect(produced).toEqual([])
  })
})

describe('虎牙抓取通道与端点判定', () => {
  it('虎牙走 CDP 抓帧', () => {
    expect(huyaAdapter.captureViaCdp).toBe(true)
  })

  it('识别实测到的弹幕 WS 主机', () => {
    expect(
      huyaAdapter.isDanmakuWs('wss://wsapi.huya.com/?baseinfo=DBYAJhV3ZWJoNSYwLjEuMCZ3ZWJzb2NrZXQ2')
    ).toBe(true)
    expect(huyaAdapter.isDanmakuWs('wss://6f06c95e-ws.va.huya.com/?baseinfo=x')).toBe(true)
    expect(huyaAdapter.isDanmakuWs('wss://cdnws.api.huya.com')).toBe(true)
  })

  it('不把页面自身的其它请求误判成弹幕通道（不要用宽泛的 /huya/i）', () => {
    expect(huyaAdapter.isDanmakuWs('https://www.huya.com/lpl')).toBe(false)
    expect(huyaAdapter.isDanmakuWs('https://huyaimg.msstatic.com/avatar/x.jpg')).toBe(false)
    expect(huyaAdapter.isDanmakuWs('wss://mon.huya.com/track')).toBe(false)
  })
})
