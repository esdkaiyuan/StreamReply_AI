import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  createDirectClient,
  type DirectHooks,
  type HttpJson,
  type SocketLike
} from '../src/main/adapters/bilibili/directClient'
import { OP, buildPacket } from '../src/main/adapters/bilibili/protocol'
import { getMixinKey, signWbi } from '../src/main/adapters/bilibili/wbi'

/* ------------------------------------------------------------------ 夹具 */

class FakeSocket implements SocketLike {
  binaryType = ''
  sent: Uint8Array[] = []
  closed = false
  /** 0 = CONNECTING，1 = OPEN，3 = CLOSED（与 WHATWG 一致） */
  readyState = 0
  private listeners = new Map<string, Array<(ev: { data?: unknown }) => void>>()

  constructor(readonly url: string) {}

  addEventListener(type: string, cb: (ev: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(cb)
    this.listeners.set(type, list)
  }
  send(data: Uint8Array): void {
    this.sent.push(data)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.emit('close', {})
  }
  fireOpen(): void {
    this.readyState = 1
    this.emit('open', {})
  }
  fireMessage(data: Buffer): void {
    this.emit('message', { data })
  }
  /** 握手失败：只发 error，不发 close */
  fireErrorOnly(): void {
    this.readyState = 3
    this.emit('error', {})
  }
  /** 连接已建立后偶发 error（readyState 不变） */
  fireErrorKeepingState(): void {
    this.emit('error', {})
  }
  private emit(type: string, ev: { data?: unknown }): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev)
  }
}

const REAL_ROOM_ID = 21144080
const IMG_URL = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'
const SUB_URL = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'

const CANNED: Array<[string, unknown]> = [
  ['Room/room_init', { code: 0, data: { room_id: REAL_ROOM_ID, live_status: 1 } }],
  [
    'x/web-interface/nav',
    { code: -101, data: { wbi_img: { img_url: IMG_URL, sub_url: SUB_URL } } }
  ],
  ['finger/spi', { code: 0, data: { b_3: 'B3VALUE', b_4: 'B4VALUE' } }],
  [
    'getDanmuInfo',
    {
      code: 0,
      data: {
        token: 'tok-abc',
        host_list: [
          { host: 'a.chat.bilibili.com', wss_port: 2245 },
          { host: 'b.chat.bilibili.com', wss_port: 2245 }
        ]
      }
    }
  ]
]

interface Harness {
  start: () => void
  sockets: FakeSocket[]
  httpCalls: Array<{ url: string; referer: string }>
  authOk: string[]
  frames: Buffer[]
  popularity: number[]
  errors: string[]
  logs: string[]
  stop: () => void
}

function setup(
  overrides: {
    heartbeatMs?: number
    failDanmuInfo?: boolean
    failDanmuInfoOnce?: boolean
    backoffBaseMs?: number
    resolveAttempts?: number
  } = {}
): Harness {
  const sockets: FakeSocket[] = []
  const httpCalls: Array<{ url: string; referer: string }> = []
  const authOk: string[] = []
  const frames: Buffer[] = []
  const popularity: number[] = []
  const errors: string[] = []
  const logs: string[] = []
  let danmuInfoCalls = 0

  const http: HttpJson = async (url, referer) => {
    httpCalls.push({ url, referer })
    if (url.includes('getDanmuInfo')) {
      danmuInfoCalls++
      if (overrides.failDanmuInfo) return { code: -352, message: '风控' }
      if (overrides.failDanmuInfoOnce && danmuInfoCalls === 1) throw new Error('net::ERR_CONNECTION_CLOSED')
    }
    for (const [needle, payload] of CANNED) {
      if (url.includes(needle)) return payload
    }
    throw new Error(`未预期的请求: ${url}`)
  }

  const hooks: DirectHooks = {
    onAuthOk: (h) => authOk.push(h),
    onFrame: (b) => frames.push(b),
    onPopularity: (n) => popularity.push(n),
    onError: (m) => errors.push(m),
    onLog: (_l, m) => logs.push(m)
  }

  const client = createDirectClient('55', hooks, {
    http,
    createSocket: (url) => {
      const s = new FakeSocket(url)
      sockets.push(s)
      return s
    },
    heartbeatMs: overrides.heartbeatMs,
    backoffBaseMs: overrides.backoffBaseMs,
    resolveAttempts: overrides.resolveAttempts
  })

  return {
    start: () => client.start(),
    stop: () => client.stop(),
    sockets,
    httpCalls,
    authOk,
    frames,
    popularity,
    errors,
    logs
  }
}

/** 直连引擎内部是 async 链，用微任务冲刷代替真实等待（不受假定时器影响） */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

const authReply = (code: number): Buffer =>
  buildPacket(OP.AUTH_REPLY, 1, Buffer.from(JSON.stringify({ code })))
const popularityReply = (n: number): Buffer => {
  const body = Buffer.alloc(4)
  body.writeUInt32BE(n, 0)
  return buildPacket(OP.HEARTBEAT_REPLY, 1, body)
}
const messagePacket = (): Buffer =>
  buildPacket(OP.MESSAGE, 0, Buffer.from(JSON.stringify({ cmd: 'DANMU_MSG', info: [[], '你好'] })))

afterEach(() => {
  vi.useRealTimers()
})

/* ------------------------------------------------------------------ 测试 */

describe('WBI 签名', () => {
  it('mixinKey 与官方示例一致（外部基准值）', () => {
    expect(getMixinKey(IMG_URL, SUB_URL)).toBe('ea1db124af3c7062474693fa704f4ff8')
  })

  it('固定 wts 下签名可复现', () => {
    const query = signWbi({ id: 21144080, type: 0 }, 'ea1db124af3c7062474693fa704f4ff8', 1700000000)
    expect(query).toBe('id=21144080&type=0&wts=1700000000&w_rid=e5581676de1e19116240849d1fcb3fa9')
  })

  it('参数按字典序参与签名', () => {
    const query = signWbi({ type: 0, id: 1 }, 'k', 1700000000)
    expect(query.startsWith('id=1&type=0&wts=1700000000&w_rid=')).toBe(true)
  })
})

describe('弹幕直连：握手', () => {
  it('短号→真实房间号，并用 WBI 签名取弹幕服务器', async () => {
    const h = setup()
    h.start()
    await flush()

    expect(h.httpCalls[0]!.url).toContain('room_init?id=55')
    const danmuCall = h.httpCalls.find((c) => c.url.includes('getDanmuInfo'))!
    expect(danmuCall.url).toContain(`id=${REAL_ROOM_ID}`)
    expect(danmuCall.url).toContain('&w_rid=')
    expect(danmuCall.referer).toContain(String(REAL_ROOM_ID))

    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0]!.url).toBe('wss://a.chat.bilibili.com:2245/sub')
  })

  it('连接建立后发送鉴权包（op=7，含 roomid/token/匿名 buvid/protover=3）', async () => {
    const h = setup()
    h.start()
    await flush()
    h.sockets[0]!.fireOpen()

    const first = h.sockets[0]!.sent[0]!
    const buf = Buffer.from(first)
    expect(buf.readUInt32BE(8)).toBe(OP.AUTH)
    const body = JSON.parse(buf.subarray(16).toString('utf8'))
    expect(body).toMatchObject({
      roomid: REAL_ROOM_ID,
      protover: 3,
      platform: 'web',
      type: 2,
      key: 'tok-abc',
      buvid: 'B4VALUE',
      uid: 0
    })
  })

  it('鉴权应答 code=0 → 回调 onAuthOk', async () => {
    const h = setup()
    h.start()
    await flush()
    h.sockets[0]!.fireOpen()
    h.sockets[0]!.fireMessage(authReply(0))

    expect(h.authOk).toEqual(['wss://a.chat.bilibili.com:2245/sub'])
    expect(h.errors).toEqual([])
  })

  it('op=5 数据帧原样交给上层解析（不在直连层解包）', async () => {
    const h = setup()
    h.start()
    await flush()
    h.sockets[0]!.fireOpen()
    h.sockets[0]!.fireMessage(messagePacket())

    expect(h.frames).toHaveLength(1)
    expect(h.frames[0]!.readUInt32BE(8)).toBe(OP.MESSAGE)
    expect(h.frames[0]!.subarray(16).toString('utf8')).toContain('DANMU_MSG')
  })

  it('心跳应答解析出人气值', async () => {
    const h = setup()
    h.start()
    await flush()
    h.sockets[0]!.fireOpen()
    h.sockets[0]!.fireMessage(popularityReply(14580))

    expect(h.popularity).toEqual([14580])
  })

  it('鉴权被拒 → 报致命错误且不再重连', async () => {
    const h = setup()
    h.start()
    await flush()
    h.sockets[0]!.fireOpen()
    h.sockets[0]!.fireMessage(authReply(-101))

    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toContain('-101')
    expect(h.sockets).toHaveLength(1) // 未发起重连
  })

  it('取弹幕服务器信息失败 → 重试耗尽后报错（供上层降级）', async () => {
    const h = setup({ failDanmuInfo: true, backoffBaseMs: 1 })
    h.start()
    await flush()
    await new Promise((r) => setTimeout(r, 30)) // 等退避重试
    await flush()

    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toContain('获取弹幕服务器信息失败')
    expect(h.sockets).toHaveLength(0)
    // 默认尝试 3 次
    expect(h.httpCalls.filter((c) => c.url.includes('getDanmuInfo'))).toHaveLength(3)
  })

  it('首次网络抖动会重试，第二次成功即正常建立连接', async () => {
    const h = setup({ failDanmuInfoOnce: true, backoffBaseMs: 1 })
    h.start()
    await flush()
    await new Promise((r) => setTimeout(r, 30))
    await flush()

    expect(h.errors).toEqual([])
    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0]!.url).toBe('wss://a.chat.bilibili.com:2245/sub')
  })
})

describe('弹幕直连：心跳与生命周期', () => {
  it('按周期发送心跳包（op=2）', async () => {
    vi.useFakeTimers()
    const h = setup({ heartbeatMs: 25_000 })
    h.start()
    await flush()
    h.sockets[0]!.fireOpen()

    expect(h.sockets[0]!.sent).toHaveLength(1) // 只有鉴权包
    await vi.advanceTimersByTimeAsync(25_000)
    expect(h.sockets[0]!.sent).toHaveLength(2)
    expect(Buffer.from(h.sockets[0]!.sent[1]!).readUInt32BE(8)).toBe(OP.HEARTBEAT)
  })

  it('连接断开后自动重连（换下一个 host）', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.start()
    await flush()
    h.sockets[0]!.fireOpen()
    h.sockets[0]!.close()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.sockets).toHaveLength(2)
    expect(h.sockets[1]!.url).toBe('wss://b.chat.bilibili.com:2245/sub')
    expect(h.errors).toEqual([])
  })

  it('stop() 后不再重连、不再心跳', async () => {
    vi.useFakeTimers()
    const h = setup({ heartbeatMs: 1_000 })
    h.start()
    await flush()
    h.sockets[0]!.fireOpen()
    h.stop()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.sockets).toHaveLength(1)
    expect(h.sockets[0]!.closed).toBe(true)
  })

  it('握手失败只发 error 不发 close 时，也会触发重连（否则房间永久卡在加载中）', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.start()
    await flush()

    h.sockets[0]!.fireErrorOnly()
    expect(h.errors).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)

    expect(h.sockets).toHaveLength(2)
    expect(h.sockets[1]!.url).toBe('wss://b.chat.bilibili.com:2245/sub')
  })

  it('已 OPEN 的连接偶发 error 不重连（避免换掉可用连接）', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.start()
    await flush()
    h.sockets[0]!.fireOpen()

    // readyState 保持 OPEN
    h.sockets[0]!.fireErrorKeepingState()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(h.sockets).toHaveLength(1)
  })
})
