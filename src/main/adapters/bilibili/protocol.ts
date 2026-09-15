import { brotliDecompressSync } from 'zlib'

export const OP = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8
} as const

const HEADER_LEN = 16

export interface RawPacket {
  op: number
  protover: number
  /** 与输入缓冲共享内存；需长期持有请自行 copy */
  body: Buffer
}

/** 将一帧（或多个串联帧）的缓冲拆为 RawPacket 列表，截断尾包安全忽略 */
export function splitPackets(buf: Buffer): RawPacket[] {
  const packets: RawPacket[] = []
  let offset = 0
  while (offset + HEADER_LEN <= buf.length) {
    const packetLen = buf.readUInt32BE(offset)
    if (packetLen < HEADER_LEN || offset + packetLen > buf.length) break
    const headerLen = buf.readUInt16BE(offset + 4)
    if (headerLen < HEADER_LEN || headerLen > packetLen) break
    packets.push({
      protover: buf.readUInt16BE(offset + 6),
      op: buf.readUInt32BE(offset + 8),
      body: buf.subarray(offset + headerLen, offset + packetLen)
    })
    offset += packetLen
  }
  return packets
}

/** 解出可读 body：protover 3 先 brotli 解压再拆子帧，返回子帧 body 列表 */
export function decodeBody(packet: RawPacket): Buffer[] {
  if (packet.protover === 3) {
    let raw: Buffer
    try {
      // 上限远大于 B 站实际子帧（KB 级），防解压炸弹
      raw = brotliDecompressSync(packet.body, { maxOutputLength: 8 * 1024 * 1024 })
    } catch {
      return [] // 损坏/恶意帧安全丢弃
    }
    return splitPackets(raw).map((p) => p.body)
  }
  if (packet.protover === 0) return [packet.body]
  return [] // protover 1(人气心跳)/2(旧zlib，已弃用) 由调用方另行处理
}

/** 按协议构造一帧数据 */
export function buildPacket(op: number, protover: number, body: Buffer): Buffer {
  const head = Buffer.alloc(HEADER_LEN)
  head.writeUInt32BE(HEADER_LEN + body.length, 0)
  head.writeUInt16BE(HEADER_LEN, 4)
  head.writeUInt16BE(protover, 6)
  head.writeUInt32BE(op, 8)
  head.writeUInt32BE(1, 12)
  return Buffer.concat([head, body])
}

/** 心跳包（op=2，空体），主进程直连时按周期发送 */
export function heartbeatPacket(): Buffer {
  return buildPacket(OP.HEARTBEAT, 1, Buffer.alloc(0))
}

/**
 * 鉴权包体（op=7）。
 * `protover: 3` 要求服务端用 brotli 压缩弹幕数据；`uid: 0` 为游客态，
 * 实测游客 + 匿名 buvid 即可正常接收弹幕。
 */
export function buildAuthBody(p: {
  roomId: string | number
  token: string
  buvid?: string
  uid?: number
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      uid: p.uid ?? 0,
      roomid: Number(p.roomId),
      protover: 3,
      buvid: p.buvid ?? '',
      platform: 'web',
      type: 2,
      key: p.token
    })
  )
}

/**
 * 从心跳应答（op=3）里读人气值。
 * 线上为 4 字节大端；个别服务端会发 8 字节且只有一侧有值，故两侧都试。
 */
export function readPopularity(packet: RawPacket): number | undefined {
  const body = packet.body
  if (body.length < 4) return undefined
  const first = body.readUInt32BE(0)
  if (body.length >= 8) return first || body.readUInt32BE(body.length - 4)
  return first
}

/** 从鉴权应答（op=8）里读 code：0 表示通过，非 0 表示被拒（如 -101 未登录 / 101 token 失效） */
export function readAuthCode(packet: RawPacket): number | undefined {
  const bodies = packet.protover === 3 ? decodeBody(packet) : [packet.body]
  for (const body of bodies) {
    if (!body.length) continue
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { code?: unknown }
      if (typeof parsed?.code === 'number') return parsed.code
    } catch {
      /* 非法 JSON（空体/心跳体）跳过 */
    }
  }
  return undefined
}
