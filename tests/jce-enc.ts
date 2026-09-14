/** JCE/Tars 编码器（测试用），语义与虎牙各 TarsStruct 的 WriteTo 一致 */

export const JCE_T = {
  BYTE: 0,
  SHORT: 1,
  INT: 2,
  LONG: 3,
  STRING1: 6,
  STRING4: 7,
  LIST: 9,
  STRUCT_BEGIN: 10,
  STRUCT_END: 11,
  ZERO: 12
} as const

export function jHead(tag: number, type: number): number[] {
  if (tag < 15) return [(tag << 4) | type]
  return [(15 << 4) | type, tag]
}

export function jInt(tag: number, value: number): number[] {
  if (value === 0) return jHead(tag, JCE_T.ZERO)
  const b = Buffer.alloc(4)
  b.writeInt32BE(value, 0)
  return [...jHead(tag, JCE_T.INT), ...b]
}

export function jLong(tag: number, value: bigint | number): number[] {
  const v = BigInt(value)
  if (v === 0n) return jHead(tag, JCE_T.ZERO)
  const b = Buffer.alloc(8)
  b.writeBigInt64BE(v, 0)
  return [...jHead(tag, JCE_T.LONG), ...b]
}

export function jBytes(tag: number, data: number[] | Buffer): number[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (buf.length < 256) return [...jHead(tag, JCE_T.STRING1), buf.length, ...buf]
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length, 0)
  return [...jHead(tag, JCE_T.STRING4), ...len, ...buf]
}

export function jStr(tag: number, s: string): number[] {
  return jBytes(tag, Buffer.from(s, 'utf8'))
}

/** 嵌套结构体：STRUCT_BEGIN … STRUCT_END */
export function jStruct(tag: number, body: number[]): number[] {
  return [...jHead(tag, JCE_T.STRUCT_BEGIN), ...body, ...jHead(0, JCE_T.STRUCT_END)]
}

/** 列表：LIST 头 + 每个元素（各自带头）+ 空头收尾 */
export function jList(tag: number, items: number[][]): number[] {
  const out = [...jHead(tag, JCE_T.LIST)]
  items.forEach((item, i) => {
    out.push(...jHead(i, JCE_T.STRUCT_BEGIN), ...item, ...jHead(0, JCE_T.STRUCT_END))
  })
  out.push(0x00) // tag=0 & type=BYTE 的终止头
  return out
}
