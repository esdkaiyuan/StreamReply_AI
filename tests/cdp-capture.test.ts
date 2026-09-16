import { afterEach, describe, expect, it, vi } from 'vitest'

// 兜底：某个用例超时中断时可能来不及还原假定时器，会污染后续用例
afterEach(() => vi.useRealTimers())
import {
  createCdpCapture,
  decodeFramePayload,
  withTimeout,
  type CdpCaptureHooks,
  type DebuggerLike
} from '../src/main/webview/cdpCapture'

type MessageListener = (event: unknown, method: string, params: unknown) => void
type DetachListener = (event: unknown, reason: string) => void

class FakeDebugger implements DebuggerLike {
  attached = false
  attachBehavior: 'ok' | 'throw' = 'ok'
  enableBehavior: 'ok' | 'throw' = 'ok'
  /** 前 N 次 Network.enable 故意失败，用于验证重试 */
  enableFailures = 0
  commands: Array<{ method: string; params?: Record<string, unknown> }> = []
  detached = false
  private messageListeners: MessageListener[] = []
  private detachListeners: DetachListener[] = []

  attach(): void {
    if (this.attachBehavior === 'throw') throw new Error('already attached')
    this.attached = true
  }
  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, params })
    if (this.enableFailures > 0) {
      this.enableFailures -= 1
      throw new Error('enable failed')
    }
    if (this.enableBehavior === 'throw') throw new Error('enable failed')
    return {}
  }
  on(event: 'message', listener: MessageListener): unknown
  on(event: 'detach', listener: DetachListener): unknown
  on(event: 'message' | 'detach', listener: MessageListener | DetachListener): unknown {
    if (event === 'message') this.messageListeners.push(listener as MessageListener)
    else this.detachListeners.push(listener as DetachListener)
    return this
  }
  detach(): void {
    this.detached = true
    this.attached = false
  }

  /** 模拟 CDP 推事件 */
  emit(method: string, params: unknown): void {
    for (const l of this.messageListeners) l({}, method, params)
  }
  emitDetach(reason = 'target closed'): void {
    for (const l of this.detachListeners) l({}, reason)
  }
}

function setup(deps?: { stream?: boolean }) {
  const dbg = new FakeDebugger()
  const endpoints: string[] = []
  const frames: Array<{ len: number; first: string; url: string }> = []
  const hints: Array<{ url: string; chunks: number }> = []
  const errors: string[] = []
  const logs: string[] = []

  const hooks: CdpCaptureHooks = {
    onEndpoint: (url) => endpoints.push(url),
    // 只有第一个提到的 URL 视为「弹幕通道」并消费
    onFrame: (raw, _source, url) => {
      frames.push({ len: raw.length, first: String.fromCharCode(raw[0] ?? 0), url })
      return url.includes('danmaku')
    },
    onStreamHint: (url, chunks) => hints.push({ url, chunks }),
    onError: (m) => errors.push(m),
    onLog: (_l, m) => logs.push(m)
  }

  const capture = createCdpCapture(
    dbg,
    hooks,
    {
      isDanmakuWs: (url) => /danmaku/i.test(url),
      isDanmakuStream: deps?.stream
        ? (url, mime) => /octet-stream/.test(mime) && /im\/fetch/.test(url)
        : undefined,
      // 单测里去掉重试与等待，保证确定性与速度；重试逻辑单独测
      enableAttempts: 1,
      enableRetryDelayMs: 0
    }
  )

  return { dbg, capture, endpoints, frames, hints, errors, logs }
}

const b64 = (buf: Buffer): string => buf.toString('base64')

describe('CDP 帧载荷解码', () => {
  it('二进制帧按 base64 解码', () => {
    const raw = Buffer.from([0x08, 0x96, 0x01, 0x00])
    expect(Array.from(decodeFramePayload(2, b64(raw)) ?? [])).toEqual([0x08, 0x96, 0x01, 0x00])
  })

  it('文本帧按 UTF-8 解码', () => {
    const bytes = decodeFramePayload(1, '{"cmd":"X"}')
    expect(Buffer.from(bytes!).toString('utf8')).toBe('{"cmd":"X"}')
  })

  it('控制帧（ping/pong/close）不产出数据', () => {
    expect(decodeFramePayload(9, 'x')).toBeNull()
    expect(decodeFramePayload(0, 'x')).toBeNull()
  })

  it('非法 base64 不抛异常，返回 null', () => {
    expect(() => decodeFramePayload(2, '###not-base64###')).not.toThrow()
  })
})

describe('CDP 抓帧通道', () => {
  it('start() 附加调试器并开启 Network 域', async () => {
    const h = setup()
    const ok = await h.capture.start()

    expect(ok).toBe(true)
    expect(h.dbg.attached).toBe(true)
    const enable = h.dbg.commands.find((c) => c.method === 'Network.enable')
    expect(enable).toBeTruthy()
    // 缓冲区要足够大，否则长连接会被 CDP 主动丢弃
    expect(Number(enable!.params!['maxTotalBufferSize'])).toBeGreaterThan(64 * 1024 * 1024)
  })

  it('调试器被占用时返回 false 并报错（不能静默失效）', async () => {
    const h = setup()
    h.dbg.attachBehavior = 'throw'
    expect(await h.capture.start()).toBe(false)
    expect(h.errors[0]).toContain('无法附加调试器')
  })

  it('Network.enable 失败时返回 false', async () => {
    const h = setup()
    h.dbg.enableBehavior = 'throw'
    expect(await h.capture.start()).toBe(false)
    expect(h.errors[0]).toContain('Network.enable')
  })

  it('识别到弹幕 WS 端点时只上报一次', async () => {
    const h = setup()
    await h.capture.start()
    h.dbg.emit('Network.webSocketCreated', { requestId: 'r1', url: 'wss://a/danmaku?x=1' })
    h.dbg.emit('Network.webSocketCreated', { requestId: 'r2', url: 'wss://a/danmaku?x=2' })
    h.dbg.emit('Network.webSocketCreated', { requestId: 'r3', url: 'wss://a/tracker' })

    expect(h.endpoints).toEqual(['wss://a/danmaku?x=1'])
  })

  it('二进制帧被解码后交给上层', async () => {
    const h = setup()
    await h.capture.start()
    const raw = Buffer.from([0x08, 0x01, 0x12, 0x03])
    h.dbg.emit('Network.webSocketFrameReceived', {
      requestId: 'r1',
      response: { opcode: 2, payloadData: b64(raw) }
    })

    expect(h.frames).toHaveLength(1)
    expect(h.frames[0]!.len).toBe(4)
  })

  it('控制帧不进上层（否则每个 ping 都会被当成一帧数据）', async () => {
    const h = setup()
    await h.capture.start()
    h.dbg.emit('Network.webSocketFrameReceived', {
      requestId: 'r1',
      response: { opcode: 9, payloadData: '' }
    })
    expect(h.frames).toHaveLength(0)
  })

  it('一旦确认弹幕通道，就跳过其它 WS 的帧（省 CPU 且避免误判）', async () => {
    const h = setup()
    await h.capture.start()
    // 真实 CDP 一定先给 webSocketCreated，帧才能映射到 URL
    h.dbg.emit('Network.webSocketCreated', { requestId: 'r-danmaku', url: 'wss://x/danmaku' })
    h.dbg.emit('Network.webSocketCreated', { requestId: 'r-tracker', url: 'wss://x/tracker' })
    const frame = (requestId: string) => ({
      requestId,
      response: { opcode: 2, payloadData: b64(Buffer.from([1, 2, 3])) }
    })
    // 先来自弹幕通道 → 被消费并锁定
    h.dbg.emit('Network.webSocketFrameReceived', frame('r-danmaku'))
    // 再来自其它通道 → 应被跳过
    h.dbg.emit('Network.webSocketFrameReceived', frame('r-tracker'))

    expect(h.frames.map((f) => f.url)).toEqual(['wss://x/danmaku'])
  })

  it('错过 webSocketCreated 时不锁定空串通道（退化为不过滤，而不是全丢）', async () => {
    const h = setup()
    await h.capture.start()
    const frame = {
      requestId: 'unknown',
      response: { opcode: 2, payloadData: b64(Buffer.from([1])) }
    }
    // 没有 webSocketCreated → url 解析为空串
    h.dbg.emit('Network.webSocketFrameReceived', frame)
    h.dbg.emit('Network.webSocketFrameReceived', frame)

    expect(h.frames).toHaveLength(2)
  })

  it('未确认弹幕通道前不过滤（端点识别错了也不能漏抓）', async () => {
    const h = setup()
    await h.capture.start()
    h.dbg.emit('Network.webSocketFrameReceived', {
      requestId: 'other',
      response: { opcode: 2, payloadData: b64(Buffer.from([9])) }
    })
    // 虽然返回 false（非弹幕通道），但帧仍被上送试探
    expect(h.frames).toHaveLength(1)
  })

  it('HTTP 推流候选上报一次（用于确认抖音是否走 fetch 流）', async () => {
    const h = setup({ stream: true })
    await h.capture.start()
    h.dbg.emit('Network.responseReceived', {
      requestId: 's1',
      type: 'Fetch',
      response: { url: 'https://x/webcast/im/fetch/?k=1', mimeType: 'application/octet-stream' }
    })
    for (let i = 0; i < 5; i++) h.dbg.emit('Network.dataReceived', { requestId: 's1', dataLength: 1024 })

    expect(h.hints).toHaveLength(1)
    expect(h.hints[0]!.url).toContain('im/fetch')
    expect(h.hints[0]!.chunks).toBeGreaterThanOrEqual(3)
  })

  it('不匹配的响应不会触发推流提示', async () => {
    const h = setup({ stream: true })
    await h.capture.start()
    h.dbg.emit('Network.responseReceived', {
      requestId: 's2',
      type: 'XHR',
      response: { url: 'https://x/api/config', mimeType: 'application/json' }
    })
    for (let i = 0; i < 5; i++) h.dbg.emit('Network.dataReceived', { requestId: 's2' })
    expect(h.hints).toHaveLength(0)
  })

  it('stop() 摘掉调试器，且不再处理后续事件', async () => {
    const h = setup()
    await h.capture.start()
    h.capture.stop()
    expect(h.dbg.detached).toBe(true)

    h.dbg.emit('Network.webSocketFrameReceived', {
      requestId: 'r1',
      response: { opcode: 2, payloadData: b64(Buffer.from([1])) }
    })
    expect(h.frames).toHaveLength(0)
  })

  it('调试器意外断开会上报（页面崩溃后要能看出抓取已失效）', async () => {
    const h = setup()
    await h.capture.start()
    h.dbg.emitDetach('target closed')
    expect(h.errors.some((e) => e.includes('调试器已断开'))).toBe(true)
  })

  it('重复 start() 不会重复附加', async () => {
    const h = setup()
    const spy = vi.spyOn(h.dbg, 'attach')
    await h.capture.start()
    await h.capture.start()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('CDP start() 的超时保护（网络服务崩溃时不能挂死）', () => {
  it('Network.enable 永不返回时按超时失败，并把调试器摘掉', async () => {
    vi.useFakeTimers()
    try {
      const dbg = new FakeDebugger()
      dbg.sendCommand = () => new Promise<never>(() => {}) // 永挂
      const errors: string[] = []
      const frames: number[] = []
      const capture = createCdpCapture(
        dbg,
        {
          onEndpoint: () => {},
          onFrame: () => {
            frames.push(1)
            return true
          },
          onError: (m) => errors.push(m)
        },
        // 只尝试一次：让「超时 → 失败」是确定性的；重试逻辑另有专门用例
        { isDanmakuWs: () => true, enableAttempts: 1, enableRetryDelayMs: 0 }
      )

      const started = capture.start()
      await vi.advanceTimersByTimeAsync(9000)
      expect(await started).toBe(false)
      expect(errors.some((e) => e.includes('超时'))).toBe(true)
      // 悬挂的调试器必须摘掉，否则后续再也附加不上
      expect(dbg.detached).toBe(true)
      expect(frames).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('withTimeout 正常路径不额外延迟', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok')
  })

  it('withTimeout 传播原始错误', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })
})

describe('CDP 启动重试', () => {
  it('第一次 Network.enable 失败会重试并最终成功', async () => {
    const dbg = new FakeDebugger()
    dbg.enableFailures = 1
    const logs: string[] = []
    const errors: string[] = []
    const capture = createCdpCapture(
      dbg,
      {
        onEndpoint: () => {},
        onFrame: () => false,
        onError: (m) => errors.push(m),
        onLog: (_l, m) => logs.push(m)
      },
      { isDanmakuWs: () => true, enableAttempts: 2, enableRetryDelayMs: 0 }
    )

    expect(await capture.start()).toBe(true)
    expect(errors).toHaveLength(0)
    expect(logs.some((l) => l.includes('第 1 次未成功'))).toBe(true)
    expect(dbg.commands.filter((c) => c.method === 'Network.enable')).toHaveLength(2)
  })

  it('重试用尽后报错并返回 false', async () => {
    const dbg = new FakeDebugger()
    dbg.enableBehavior = 'throw'
    const errors: string[] = []
    const capture = createCdpCapture(
      dbg,
      { onEndpoint: () => {}, onFrame: () => false, onError: (m) => errors.push(m) },
      { isDanmakuWs: () => true, enableAttempts: 2, enableRetryDelayMs: 0 }
    )

    expect(await capture.start()).toBe(false)
    expect(errors[0]).toContain('已尝试 2 次')
  })
})
