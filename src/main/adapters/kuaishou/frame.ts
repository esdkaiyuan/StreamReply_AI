import { gunzipSync } from 'zlib'
import { asBytes, asNumber, decodeMessage } from '../protobuf'

/** 解压上限，防解压炸弹（与其他适配器同一安全基线） */
const MAX_DECOMPRESSED = 8 * 1024 * 1024

/** 快手 PayloadType 枚举（摘自公开协议定义，仅列出会用到的） */
export const KS_PAYLOAD = {
  SC_HEARTBEAT_ACK: 101,
  SC_ERROR: 103,
  SC_INFO: 105,
  SC_ENTER_ROOM_ACK: 300,
  /** 弹幕 / 礼物 / 点赞推送主通道 */
  SC_FEED_PUSH: 310,
  SC_RED_PACK_FEED: 330,
  SC_LIVE_WATCHING_LIST: 340
} as const

/** CompressionType: 0=UNKNOWN 1=NONE 2=GZIP 3=AES */
const COMPRESSION_GZIP = 2
const COMPRESSION_AES = 3

export interface KsSocketMessage {
  payloadType: number
  compressionType: number
  payload: Buffer
}

/**
 * SocketMessage { payloadType=1, compressionType=2, payload=3 }
 * GZIP 时对 payload 解压；AES 不支持，返回 null 让上层明确忽略而不是产出垃圾数据。
 */
export function parseSocketMessage(raw: Buffer): KsSocketMessage | null {
  if (raw.length === 0) return null
  const msg = decodeMessage(raw)
  const payloadType = asNumber(msg, 1)
  const compressionType = asNumber(msg, 2)
  const payload = asBytes(msg, 3)
  if (payloadType === 0 || !payload) return null
  if (compressionType === COMPRESSION_AES) return null

  if (compressionType === COMPRESSION_GZIP) {
    try {
      return {
        payloadType,
        compressionType,
        payload: gunzipSync(payload, { maxOutputLength: MAX_DECOMPRESSED })
      }
    } catch {
      return null
    }
  }
  return { payloadType, compressionType, payload }
}

/**
 * 把形如 "4772" / "1.2万" / "3.4亿" 的展示值转成数字。
 * 快手的人数/点赞数是字符串展示值，不解析就只能整块丢弃。
 */
export function parseDisplayCount(display: string): number | undefined {
  const t = display.trim()
  if (!t) return undefined
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([万亿]?)/)
  if (!m) return undefined
  const base = Number(m[1])
  if (!Number.isFinite(base)) return undefined
  if (m[2] === '万') return Math.round(base * 10_000)
  if (m[2] === '亿') return Math.round(base * 100_000_000)
  return Math.round(base)
}
