import { gunzipSync, inflateRawSync, inflateSync } from 'zlib'
import { asBytes, asString, decodeMessage, type ProtoMessage } from '../protobuf'

/** 解压上限，防解压炸弹（与 B 站协议层同一安全基线） */
const MAX_DECOMPRESSED = 8 * 1024 * 1024

export interface DouyinImMessage {
  method: string
  payload: Buffer
}

/**
 * payloadEncoding 字段不可靠，按 gzip 魔数 → zlib → raw deflate 依次尝试；
 * 都不是就当未压缩原样返回。
 */
export function maybeDecompress(buf: Buffer): Buffer {
  const opts = { maxOutputLength: MAX_DECOMPRESSED }
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      return gunzipSync(buf, opts)
    } catch {
      return buf
    }
  }
  try {
    return inflateSync(buf, opts)
  } catch {
    /* 落到 raw deflate */
  }
  try {
    return inflateRawSync(buf, opts)
  } catch {
    return buf
  }
}

/**
 * PushFrame(8: payload) → 解压 → Response(1: messagesList) → 逐条取出 method + payload。
 * 任一环节不合法即返回空数组，调用方据此判定「不是抖音帧」。
 */
export function parsePushFrame(raw: Buffer): DouyinImMessage[] {
  if (raw.length === 0) return []
  let frame: ProtoMessage
  try {
    frame = decodeMessage(raw)
  } catch {
    return []
  }
  const compressed = asBytes(frame, 8)
  if (!compressed || compressed.length === 0) return []

  let response: ProtoMessage
  try {
    response = decodeMessage(maybeDecompress(compressed))
  } catch {
    return []
  }
  const list = response.get(1)
  if (!list) return []

  const out: DouyinImMessage[] = []
  for (const item of list) {
    if (item.wire !== 2) continue
    const message = decodeMessage(item.data)
    const method = asString(message, 1)
    const payload = asBytes(message, 2)
    if (method && payload && payload.length > 0) out.push({ method, payload })
  }
  return out
}
