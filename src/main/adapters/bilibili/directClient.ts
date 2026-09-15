import type { RawPacket } from './protocol'
import {
  OP,
  buildAuthBody,
  buildPacket,
  heartbeatPacket,
  readAuthCode,
  readPopularity,
  splitPackets
} from './protocol'
import { getMixinKey, signWbi } from './wbi'

/**
 * B 站弹幕「主进程直连」客户端。
 *
 * 为什么需要它：实测（2026-09-15）当前网页端把弹幕连接建在 blob Worker 内，
 * 主世界包装 `window.WebSocket` 看不到；同主机的 WS 还混着 WebRTC 信令。
 * 与其层层绕过页面，不如让主进程直接连官方弹幕服务器：
 * `room_init` 解析真实房间号 → `getDanmuInfo`（WBI 签名）取 token 与 host 列表
 * → `wss://<host>:<port>/sub` 鉴权 → 心跳 → 收帧。
 *
 * 本模块不依赖 electron，网络与 socket 均由 deps 注入，便于单测整个握手流程。
 */

export interface SocketLike {
  binaryType: string
  send(data: Uint8Array): void
  close(): void
  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void
  /** 1 = OPEN。某些实现握手失败只发 error 不发 close，需要靠它判断是否该重连 */
  readyState?: number
}

/** 返回接口 JSON；失败应抛错 */
export type HttpJson = (url: string, referer: string) => Promise<unknown>

export interface DirectHooks {
  /** 鉴权通过：已确实连上弹幕服务器 */
  onAuthOk(host: string): void
  /** 收到 op=5 数据帧（原始字节，交给适配器 parseFrame 解析） */
  onFrame(raw: Buffer): void
  /** 心跳回报的人气值 */
  onPopularity(count: number): void
  /** 致命错误：无法取到弹幕服务器信息、鉴权被拒、重连耗尽 */
  onError(message: string): void
  onLog?(level: 'info' | 'warn' | 'error', message: string): void
}

export interface DirectClient {
  start(): void
  stop(): void
}

export interface DirectDeps {
  http: HttpJson
  createSocket(url: string): SocketLike
  /** 心跳间隔，默认 25s（服务端要求 ≤30s） */
  heartbeatMs?: number
  /** 重连退避基数，默认 2s，线性递增 */
  backoffBaseMs?: number
  /** 连续重连上限，超过即报致命错误 */
  maxAttempts?: number
  /** 握手前「取弹幕服务器信息」的尝试次数，默认 3（容忍瞬时网络抖动） */
  resolveAttempts?: number
}

interface ResolvedTarget {
  realRoomId: string
  token: string
  buvid: string
  /** 形如 wss://host:port/sub */
  urls: string[]
}

const REFERER = 'https://live.bilibili.com/'
const ROOM_INIT = (id: string): string =>
  `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(id)}`
const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const FINGER_SPI = 'https://api.bilibili.com/x/frontend/finger/spi'
const DANMU_INFO = (id: string, query: string): string =>
  `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`

interface NavData {
  data?: { wbi_img?: { img_url?: string; sub_url?: string } }
}
interface RoomInitData {
  data?: { room_id?: number; live_status?: number }
}
interface SpiData {
  data?: { b_3?: string; b_4?: string }
}
interface DanmuInfoData {
  code?: number
  message?: string
  data?: { token?: string; host_list?: Array<{ host?: string; wss_port?: number }> }
}

/** 真实房间号（短号需转换）+ WBI 密钥 + 匿名 buvid + 弹幕服务器地址 */
async function resolveTarget(roomId: string, http: HttpJson): Promise<ResolvedTarget> {
  const init = (await http(ROOM_INIT(roomId), REFERER)) as RoomInitData
  const realRoomId = String(init?.data?.room_id ?? roomId)

  const [nav, spi] = await Promise.all([
    http(NAV, REFERER) as Promise<NavData>,
    http(FINGER_SPI, REFERER) as Promise<SpiData>
  ])
  const imgUrl = nav?.data?.wbi_img?.img_url ?? ''
  const subUrl = nav?.data?.wbi_img?.sub_url ?? ''
  if (!imgUrl || !subUrl) throw new Error('nav 未返回 wbi_img，无法签名')

  const buvid = spi?.data?.b_4 || spi?.data?.b_3 || ''
  const query = signWbi({ id: realRoomId, type: 0 }, getMixinKey(imgUrl, subUrl), Math.floor(Date.now() / 1000))
  const info = (await http(DANMU_INFO(realRoomId, query), `${REFERER}${realRoomId}`)) as DanmuInfoData
  if (info?.code !== 0) throw new Error(`getDanmuInfo 失败 code=${info?.code ?? '?'} ${info?.message ?? ''}`)

  const urls = (info.data?.host_list ?? [])
    .filter((h) => h.host && h.wss_port)
    .map((h) => `wss://${h.host}:${h.wss_port}/sub`)

  return { realRoomId, token: info.data?.token ?? '', buvid, urls }
}

/** CDP/undici 的 WS 帧可能是 ArrayBuffer / Buffer / 视图 / 字符串 */
function toBuffer(data: unknown): Buffer | null {
  if (data == null) return null
  if (typeof data === 'string') return Buffer.from(data, 'utf8')
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return null
}

export function createDirectClient(
  roomId: string,
  hooks: DirectHooks,
  deps: DirectDeps
): DirectClient {
  const heartbeatMs = deps.heartbeatMs ?? 25_000
  const backoffBaseMs = deps.backoffBaseMs ?? 2_000
  const maxAttempts = deps.maxAttempts ?? 5
  const resolveAttempts = deps.resolveAttempts ?? 3

  let stopped = false
  let target: ResolvedTarget | null = null
  let socket: SocketLike | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0

  function clearHeartbeat(): void {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
  }

  function scheduleReconnect(reason: string): void {
    if (stopped || reconnectTimer) return
    attempt += 1
    if (attempt > maxAttempts) {
      hooks.onError(`${reason}，连续重连 ${maxAttempts} 次仍失败`)
      return
    }
    const delay = backoffBaseMs * attempt
    hooks.onLog?.('warn', `${reason}，${Math.round(delay / 1000)}s 后第 ${attempt} 次重连`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      open(attempt)
    }, delay)
  }

  /** index 为 host 下标：首次 0，重连时递增以轮换机房 */
  function open(index: number): void {
    if (stopped || !target) return
    const urls = target.urls
    if (!urls.length) {
      hooks.onError('弹幕服务器列表为空')
      return
    }
    const url = urls[Math.min(index, urls.length - 1)]!

    let sock: SocketLike
    try {
      sock = deps.createSocket(url)
    } catch (err) {
      scheduleReconnect(`建立连接失败（${String(err)}）`)
      return
    }
    socket = sock
    sock.binaryType = 'arraybuffer'

    sock.addEventListener('open', () => {
      if (stopped || !target) return
      attempt = 0
      // 鉴权帧必须带 16 字节协议头（op=7），漏掉头服务端会当作非法帧直接断开
      sock.send(
        new Uint8Array(
          buildPacket(
            OP.AUTH,
            1,
            buildAuthBody({ roomId: target.realRoomId, token: target.token, buvid: target.buvid })
          )
        )
      )
      clearHeartbeat()
      heartbeat = setInterval(() => {
        try {
          sock.send(new Uint8Array(heartbeatPacket()))
        } catch {
          /* 连接已断，等 close 事件统一处理 */
        }
      }, heartbeatMs)
    })

    sock.addEventListener('message', (ev) => {
      const raw = toBuffer(ev.data)
      if (!raw || raw.length < 16 || stopped) return
      let hasMessage = false
      let pending: RawPacket | null = null
      for (const packet of splitPackets(raw)) {
        if (packet.op === OP.MESSAGE) hasMessage = true
        else if (packet.op === OP.HEARTBEAT_REPLY) pending = packet
        else if (packet.op === OP.AUTH_REPLY) {
          const code = readAuthCode(packet)
          if (code === 0) hooks.onAuthOk(url)
          else {
            hooks.onLog?.('error', `鉴权被拒 code=${code ?? '?'}`)
            // 鉴权失败重连也会失败，直接报错交由上层降级
            stopped = true
            clearHeartbeat()
            try {
              sock.close()
            } catch {
              /* ignore */
            }
            hooks.onError(`鉴权被拒（code=${code ?? '?'}），token 或签名已失效`)
          }
        }
      }
      if (pending) {
        const count = readPopularity(pending)
        if (count !== undefined) hooks.onPopularity(count)
      }
      if (hasMessage) hooks.onFrame(raw)
    })

    sock.addEventListener('error', () => {
      hooks.onLog?.('warn', '弹幕连接出错')
      // 实测某些实现握手失败只发 error 不发 close，导致永远不重连（房间永久卡在 loading）；
      // 这里兜底触发，scheduleReconnect 自身幂等，不会重复排程。
      // 已 OPEN 的连接偶发 error 不重连，避免把可用连接换掉。
      if (socket === sock && (sock.readyState ?? 3) !== 1) scheduleReconnect('弹幕连接失败')
    })

    sock.addEventListener('close', () => {
      clearHeartbeat()
      if (socket === sock) socket = null
      if (stopped) return
      scheduleReconnect('弹幕连接断开')
    })
  }

  return {
    start(): void {
      void (async () => {
        let lastError = ''
        // 取弹幕服务器信息要过两次 HTTP（含 WBI 签名），网络抖动很常见，先重试再谈降级
        for (let i = 0; i < resolveAttempts; i++) {
          if (stopped) return
          try {
            const resolved = await resolveTarget(roomId, deps.http)
            if (stopped) return
            target = resolved
            hooks.onLog?.('info', `弹幕服务器：${resolved.urls[0] ?? '（无）'}`)
            open(0)
            return
          } catch (err) {
            lastError = String(err)
            if (i < resolveAttempts - 1) {
              const delay = backoffBaseMs * (i + 1)
              hooks.onLog?.('warn', `获取弹幕服务器信息失败（${lastError}），${delay}ms 后重试`)
              await new Promise((r) => setTimeout(r, delay))
            }
          }
        }
        if (!stopped) hooks.onError(`获取弹幕服务器信息失败：${lastError}`)
      })()
    },

    stop(): void {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      clearHeartbeat()
      const sock = socket
      socket = null
      try {
        sock?.close()
      } catch {
        /* ignore */
      }
    }
  }
}
