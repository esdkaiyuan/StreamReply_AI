/**
 * 极简 protobuf 读取器：抖音直播 IM 只用到 varint / length-delimited 两类，
 * fixed32/64 直接跳过即可。不引入 protobufjs，避免为几个字段背上一个运行时依赖。
 */

export interface ProtoField {
  wire: number
  data: Buffer
  big?: bigint
}

export type ProtoMessage = Map<number, ProtoField[]>

function readVarint(buf: Buffer, start: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let i = start
  while (i < buf.length) {
    const byte = buf[i]
    result |= BigInt(byte & 0x7f) << shift
    i += 1
    if ((byte & 0x80) === 0) return [result, i]
    shift += 7n
    if (shift > 63n) return [0n, -1]
  }
  return [0n, -1]
}

function push(map: ProtoMessage, field: number, value: ProtoField): void {
  const list = map.get(field)
  if (list) list.push(value)
  else map.set(field, [value])
}

/** 解析失败时返回已解析到的部分，绝不抛异常（坏帧直接丢弃） */
export function decodeMessage(buf: Buffer): ProtoMessage {
  const map: ProtoMessage = new Map()
  let i = 0
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i)
    if (afterKey < 0) break
    i = afterKey
    const field = Number(key >> 3n)
    const wire = Number(key & 7n)
    if (field === 0 || field > 536870911) break

    if (wire === 0) {
      const [value, next] = readVarint(buf, i)
      if (next < 0) break
      i = next
      push(map, field, { wire, data: Buffer.alloc(0), big: value })
    } else if (wire === 2) {
      const [len, afterLen] = readVarint(buf, i)
      if (afterLen < 0) break
      const end = afterLen + Number(len)
      if (end > buf.length || end < afterLen) break
      push(map, field, { wire, data: buf.subarray(afterLen, end) })
      i = end
    } else if (wire === 5) {
      if (i + 4 > buf.length) break
      i += 4
    } else if (wire === 1) {
      if (i + 8 > buf.length) break
      i += 8
    } else {
      break
    }
  }
  return map
}

export function asString(map: ProtoMessage, field: number): string {
  const v = map.get(field)?.[0]
  if (!v || v.wire !== 2) return ''
  return v.data.toString('utf8')
}

export function asBytes(map: ProtoMessage, field: number): Buffer | null {
  const v = map.get(field)?.[0]
  if (!v || v.wire !== 2) return null
  return v.data
}

export function asBigInt(map: ProtoMessage, field: number): bigint {
  const v = map.get(field)?.[0]
  if (!v || v.wire !== 0) return 0n
  return v.big ?? 0n
}

export function asNumber(map: ProtoMessage, field: number): number {
  return Number(asBigInt(map, field))
}

/** uint64 一律转字符串，避免 JS number 精度丢失（用户 id 常见 19 位） */
export function asBigString(map: ProtoMessage, field: number): string {
  const v = map.get(field)?.[0]
  if (!v || v.wire !== 0) return ''
  return (v.big ?? 0n).toString()
}

export function asMessage(map: ProtoMessage, field: number): ProtoMessage | null {
  const buf = asBytes(map, field)
  return buf ? decodeMessage(buf) : null
}
