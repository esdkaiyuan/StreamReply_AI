import type { CaptureSource } from '../../shared/types'

/**
 * 用 CDP（`webContents.debugger` + Network 域）抓直播间网络帧。
 *
 * 为什么需要它：实测 B 站把弹幕连接建在 **blob Worker** 内（2026-09-15），
 * 主世界 `window.WebSocket` patch 根本看不到；抖音这类平台同样可能在 Worker / 内部实现里建连。
 * CDP 的 `Network.*` 事件是**浏览器进程级**的，Worker 内的连接一样能看到，
 * 而且能顺手拿到端点 URL 用于过滤，比「盲 hook」稳得多。
 *
 * 设计要点：
 * - 依赖注入 `DebuggerLike`，所以整套逻辑可在单测里用假调试器跑完，无需 Electron；
 * - **端点识别错也不能漏抓**：未确认弹幕通道前，所有 WS 帧都上送试探，
 *   由上层 `parseFrame` 做严格校验；一旦某个 URL 的帧被成功消费，就只认它，省掉无谓解析；
 * - 控制帧（ping/pong/close）必须过滤，否则每个心跳都会被当成一帧数据。
 */

/** `webContents.debugger` 的最小接口，便于注入假实现 */
export interface DebuggerLike {
  attach(version: string): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: 'message', listener: (event: unknown, method: string, params: unknown) => void): unknown
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  detach(): void
}

export interface CdpCaptureHooks {
  /** 首次识别到弹幕 WS 端点 */
  onEndpoint(url: string): void
  /**
   * 收到一帧。返回 `true` 表示这一帧被成功消费（据此锁定弹幕通道）。
   * `url` 为该帧所属连接，便于上层记录/过滤。
   */
  onFrame(raw: Uint8Array, source: CaptureSource, url: string): boolean
  /**
   * 客户端**发出**的一帧（默认不关心）。
   * 用途：对照「已知的请求结构」校准解析器，以及排查发送链路被平台拒收的原因。
   */
  onSentFrame?(raw: Uint8Array, url: string): void
  /** 发现疑似「HTTP 推流」的响应（诊断用：用于确认某些平台是否走 fetch 流） */
  onStreamHint?(url: string, chunks: number): void
  onError(message: string): void
  onLog?(level: 'info' | 'warn', message: string): void
}

export interface CdpCaptureDeps {
  /** 判断某个 WS 端点是否本平台的弹幕通道（端点识别失败也能靠帧内容兜住） */
  isDanmakuWs(url: string): boolean
  /** 判断某个响应是否可能是 HTTP 推流的弹幕通道（仅用于诊断上报） */
  isDanmakuStream?(url: string, mimeType: string): boolean
  /** `Network.enable` 尝试次数，默认 2；测试可设为 1 以求确定性 */
  enableAttempts?: number
  /** 两次尝试之间的间隔，默认 1500ms */
  enableRetryDelayMs?: number
}

export interface CdpCapture {
  start(): Promise<boolean>
  stop(): void
}

/** CDP 给二进制帧的是 base64；文本帧是原始字符串 */
export function decodeFramePayload(opcode: number, payloadData: string): Uint8Array | null {
  if (opcode === 2) {
    try {
      const buf = Buffer.from(String(payloadData ?? ''), 'base64')
      return buf.length > 0 ? new Uint8Array(buf) : null
    } catch {
      return null
    }
  }
  if (opcode === 1) {
    const buf = Buffer.from(String(payloadData ?? ''), 'utf8')
    return buf.length > 0 ? new Uint8Array(buf) : null
  }
  return null // 0=continuation 8=close 9=ping 10=pong
}

interface StreamCandidate {
  url: string
  chunks: number
  reported: boolean
}

/** 连续多少个分片才认为「真的在推流」（过滤掉一次性的小响应） */
const STREAM_CHUNK_THRESHOLD = 3

/**
 * `Network.enable` 的超时上限。
 *
 * 必须给超时：实测本机 **Chromium 网络服务会崩溃重启**
 * （日志 `Network service crashed, restarting service.`），
 * 此时 `sendCommand` 可能**永远不 resolve**。
 * 而 `start()` 是被 `openRoom` await 的 —— 一旦挂住，**添加房间会整个卡死**。
 */
const ENABLE_TIMEOUT_MS = 8000

/** 给 Promise 加超时（超时即视为失败，绝不无限等待） */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

export function createCdpCapture(
  dbg: DebuggerLike,
  hooks: CdpCaptureHooks,
  deps: CdpCaptureDeps
): CdpCapture {
  let attached = false
  let stopped = false
  /** 已被确认的弹幕通道 URL；一旦确定就只认它 */
  let danmakuUrl: string | null = null
  let endpointReported = false

  const wsUrls = new Map<string, string>()
  const streams = new Map<string, StreamCandidate>()

  function handle(method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, any>

    switch (method) {
      case 'Network.webSocketCreated': {
        const url = String(p['url'] ?? '')
        wsUrls.set(String(p['requestId'] ?? ''), url)
        if (!endpointReported && deps.isDanmakuWs(url)) {
          endpointReported = true
          hooks.onEndpoint(url)
        }
        return
      }

      case 'Network.webSocketFrameReceived': {
        const url = wsUrls.get(String(p['requestId'] ?? '')) ?? ''
        // 已锁定通道：其它连接的帧直接跳过
        if (danmakuUrl !== null && url !== danmakuUrl) return
        const response = (p['response'] ?? {}) as Record<string, unknown>
        const raw = decodeFramePayload(Number(response['opcode']), String(response['payloadData'] ?? ''))
        if (!raw) return
        const consumed = hooks.onFrame(raw, 'ws', url)
        // 只有拿到真实 URL 才锁定通道：若 webSocketCreated 没被捕获到（例如在连接建立后才附加
        // 调试器），这里 url 会是空串，锁成空串会让「只认这个通道」退化成「不过滤」
        if (consumed && !danmakuUrl && url) danmakuUrl = url
        return
      }

      case 'Network.webSocketFrameSent': {
        if (!hooks.onSentFrame) return
        const response = (p['response'] ?? {}) as Record<string, unknown>
        const raw = decodeFramePayload(Number(response['opcode']), String(response['payloadData'] ?? ''))
        if (!raw) return
        hooks.onSentFrame(raw, wsUrls.get(String(p['requestId'] ?? '')) ?? '')
        return
      }

      case 'Network.webSocketFrameError': {
        hooks.onLog?.('warn', `WS 帧错误：${String(p['errorMessage'] ?? '')}`)
        return
      }

      case 'Network.responseReceived': {
        if (!deps.isDanmakuStream) return
        const response = (p['response'] ?? {}) as Record<string, unknown>
        const url = String(response['url'] ?? '')
        const mime = String(response['mimeType'] ?? '')
        if (!deps.isDanmakuStream(url, mime)) return
        streams.set(String(p['requestId'] ?? ''), { url, chunks: 0, reported: false })
        return
      }

      case 'Network.dataReceived': {
        const rec = streams.get(String(p['requestId'] ?? ''))
        if (!rec) return
        rec.chunks += 1
        if (!rec.reported && rec.chunks >= STREAM_CHUNK_THRESHOLD) {
          rec.reported = true
          hooks.onStreamHint?.(rec.url, rec.chunks)
        }
        return
      }

      default:
        return
    }
  }

  return {
    async start(): Promise<boolean> {
      if (attached) return true
      const attempts = Math.max(1, deps.enableAttempts ?? 2)
      const retryDelay = deps.enableRetryDelayMs ?? 1500

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          dbg.attach('1.3')
          attached = true
        } catch (err) {
          hooks.onError(`无法附加调试器（可能已被其它工具占用）：${String(err)}`)
          return false
        }

        try {
          // 缓冲区必须给足：长连接的帧会被 CDP 按容量裁剪，太小会凭空丢帧
          // 超时保护必不可少：实测**页面开始加载之前**附加时 Network.enable 会一直不返回，
          // 而 start() 是被 openRoom await 的 —— 没有超时就会让「添加房间」整个卡住
          await withTimeout(
            dbg.sendCommand('Network.enable', {
              maxTotalBufferSize: 256 * 1024 * 1024,
              maxResourceBufferSize: 128 * 1024 * 1024,
              maxPostDataSize: 1024 * 1024
            }),
            ENABLE_TIMEOUT_MS,
            'Network.enable'
          )
        } catch (err) {
          // 悬挂的调试器必须摘掉，否则后续再也附加不上
          attached = false
          try {
            dbg.detach()
          } catch {
            /* 忽略 */
          }
          if (attempt < attempts) {
            hooks.onLog?.(
              'warn',
              `Network.enable 第 ${attempt} 次未成功（${String(err)}），${retryDelay}ms 后重试`
            )
            await new Promise((r) => setTimeout(r, retryDelay))
            continue
          }
          hooks.onError(`Network.enable 失败（已尝试 ${attempts} 次）：${String(err)}`)
          return false
        }

        stopped = false
        dbg.on('message', (_event, method, params) => {
          if (stopped || !attached) return
          try {
            handle(method, params)
          } catch (err) {
            hooks.onLog?.('warn', `处理 ${method} 事件异常：${String(err)}`)
          }
        })
        dbg.on('detach', (_event, reason) => {
          attached = false
          if (!stopped) hooks.onError(`调试器已断开（抓取失效）：${reason}`)
        })
        hooks.onLog?.('info', 'CDP 抓帧通道已就绪（可覆盖 Worker 内的连接）')
        return true
      }
      return false
    },

    stop(): void {
      stopped = true
      wsUrls.clear()
      streams.clear()
      if (!attached) return
      attached = false
      try {
        dbg.detach()
      } catch {
        /* 已经断开就忽略 */
      }
    }
  }
}
