import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { huyaAdapter } from '../src/main/adapters/huya'
import { parseHuyaFrame, parseWebSocketCommand } from '../src/main/adapters/huya/frame'
import { mapHuyaMessage } from '../src/main/adapters/huya/mapper'

interface FixtureFrame {
  dir: 'recv' | 'sent'
  len: number
  hex: string
  note?: string
}
const fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'huya-frames.json'), 'utf8')
) as { note: string; frames: FixtureFrame[] }

const frames = fixtures.frames.map((f) => ({ ...f, buf: Buffer.from(f.hex, 'hex') }))
const chatFrames = frames.filter((f) => (f.note ?? '').includes('uri=1400'))

describe('虎牙真实帧夹具（2026-09-17 从 live.huya.com 抓取）', () => {
  it('夹具本身完好（长度与 hex 一致）', () => {
    expect(frames.length).toBeGreaterThanOrEqual(8)
    for (const f of frames) expect(f.buf.length).toBe(f.len)
  })

  it('包含 cmdType=7 的弹幕推送帧（此前一条都抓不到）', () => {
    expect(chatFrames.length).toBeGreaterThan(0)
  })

  it('信封特征：偏移 2 处是 0x1D（低半字节 = Tars 扩展的 EN_SIMPLELIST=13）', () => {
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
})

describe('虎牙 WS 信封解析（此前全部失败，2026-09-17 修复）', () => {
  it('每一帧都能解出 iCmdType 与 vData', () => {
    for (const f of frames) {
      const cmd = parseWebSocketCommand(f.buf)
      expect(cmd).not.toBeNull()
      expect(cmd!.cmdType).toBeGreaterThan(0)
    }
  })

  it('iCmdType 取值与虎牙官方枚举一致（3=WupReq 4=WupRsp 7=MsgPushReq 16/17=RegisterGroup）', () => {
    const types = frames.map((f) => parseWebSocketCommand(f.buf)!.cmdType)
    expect(types).toContain(7) // EWSCmdS2C_MsgPushReq（弹幕推送）
    expect(types).toContain(3) // EWSCmd_WupReq
    expect(types).toContain(4) // EWSCmd_WupRsp
  })

  it('cmdType=7 的帧解出 Uri，且包含 1400（弹幕）', () => {
    const produced = frames.flatMap((f) => parseHuyaFrame(f.buf))
    expect(produced.length).toBeGreaterThan(0)
    expect(produced.some((m) => m.uri === 1400)).toBe(true)
  })

  it('非推送类命令（心跳/注册响应）不产出消息，而不是产出垃圾', () => {
    const heartbeat = frames.find(
      (f) => parseWebSocketCommand(f.buf)?.cmdType === 17
    )!
    expect(parseHuyaFrame(heartbeat.buf)).toEqual([])
  })
})

describe('虎牙弹幕消息映射（真实弹幕体）', () => {
  it('解出昵称与内容（HYMessage{0:UserInfo,3:Content} / HYSender{0:Uid,2:NickName}）', () => {
    expect(chatFrames.length).toBeGreaterThan(0)
    for (const f of chatFrames) {
      const raw = parseHuyaFrame(f.buf).find((m) => m.uri === 1400)
      expect(raw).toBeTruthy()

      const mapped = mapHuyaMessage(1400, raw!.body, 'wuhushenkp')
      expect(mapped?.kind).toBe('danmaku')
      if (mapped?.kind !== 'danmaku') throw new Error('unreachable')

      expect(mapped.message.platform).toBe('huya')
      expect(mapped.message.roomId).toBe('wuhushenkp')
      expect(mapped.message.type).toBe('chat')
      expect(mapped.message.content.trim().length).toBeGreaterThan(0)
      // 昵称必须是真解出来的，不能退化成兜底值
      expect(mapped.message.user.nickname).not.toBe('未知用户')
      expect(mapped.message.user.nickname.trim().length).toBeGreaterThan(0)
      expect(mapped.message.user.uid).toMatch(/^\d+$/)
    }
  })

  it('内容不是乱码（真实弹幕应为可读文本）', () => {
    for (const f of chatFrames) {
      const raw = parseHuyaFrame(f.buf).find((m) => m.uri === 1400)!
      const mapped = mapHuyaMessage(1400, raw.body, 'wuhushenkp')
      if (mapped?.kind !== 'danmaku') throw new Error('unreachable')
      // 不应包含 U+FFFD 替换字符（那是解码失败的标志）
      expect(mapped.message.content).not.toContain('\ufffd')
      expect(mapped.message.user.nickname).not.toContain('\ufffd')
    }
  })

  it('不相关的 Uri 不产出弹幕（避免把其它业务消息误当弹幕）', () => {
    for (const f of frames) {
      for (const raw of parseHuyaFrame(f.buf)) {
        if (raw.uri === 1400) continue
        expect(mapHuyaMessage(raw.uri, raw.body, 'wuhushenkp')).toBeNull()
      }
    }
  })
})

describe('虎牙抓取通道与端点判定', () => {
  /**
   * ⚠️ 虎牙的抓取通道已从「CDP 抓 WS」改为「DOM 兜底」（2026-09-18 实测结论）：
   * WS 侧只有 1~5 条/75 秒的 uri=1400 弹幕，而页面聊天列表（#chat-room__list）
   * 才是真实弹幕的载体。这里锁住这个决策，避免被误改回去。
   */
  it('虎牙不用 CDP 抓帧，改为 DOM 兜底', () => {
    expect(huyaAdapter.captureViaCdp).toBeUndefined()
    expect(huyaAdapter.domFallbackScript()).toBeTruthy()
  })

  it('虎牙不注入页面脚本（少碰页面，降低被检测风险）', () => {
    expect(huyaAdapter.injectScript()).toBe('')
  })

  it('虎牙配置了进房前的首页预热', () => {
    expect(huyaAdapter.warmupUrl?.()).toContain('huya.com')
  })

  it('识别实测到的弹幕 WS 主机', () => {
    expect(
      huyaAdapter.isDanmakuWs('wss://wsapi.huya.com/?baseinfo=DBYAJhV3ZWJoNSYwLjEuMCZ3ZWJzb2NrZXQ2')
    ).toBe(true)
    expect(huyaAdapter.isDanmakuWs('wss://6f06c95e-ws.va.huya.com/?baseinfo=x')).toBe(true)
    expect(huyaAdapter.isDanmakuWs('wss://78dff6a2-ws.va.huya.com?baseinfo=x')).toBe(true)
    expect(huyaAdapter.isDanmakuWs('wss://cdnws.api.huya.com')).toBe(true)
  })

  it('不把页面自身的其它请求误判成弹幕通道（不要用宽泛的 /huya/i）', () => {
    expect(huyaAdapter.isDanmakuWs('https://www.huya.com/lpl')).toBe(false)
    expect(huyaAdapter.isDanmakuWs('https://huyaimg.msstatic.com/avatar/x.jpg')).toBe(false)
    expect(huyaAdapter.isDanmakuWs('wss://mon.huya.com/track')).toBe(false)
  })
})
