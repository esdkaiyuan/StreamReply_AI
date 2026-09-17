/**
 * JCE/Tars 编码器（测试用），语义与虎牙页面自带的 `JceOutputStream` 一致。
 *
 * 关键点（2026-09-17 从其实现原文读出，非推测）：
 * - `writeBytes`（byte[]）走 **SIMPLE_LIST(13)**：`head(tag,13)` + `head(0,INT8)` + 长度 + 原始字节
 * - `writeString` 走 STRING1/STRING4（与 byte[] 不同，别混用）
 * - `writeVector` 是 `head(tag,LIST)` + **长度** + 元素（各自带 tag=0 的头），**没有空头收尾**
 * - 整型是「定长大端 + 类型降级」，0 用 ZERO_TAG
 */

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
  ZERO: 12,
  SIMPLE_LIST: 13
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

/** byte[]（对应 Tars 的 `writeBytes`）→ SIMPLE_LIST */
export function jBytes(tag: number, data: number[] | Buffer): number[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return [...jHead(tag, JCE_T.SIMPLE_LIST), ...jHead(0, JCE_T.BYTE), ...jInt(0, buf.length), ...buf]
}

/** string（对应 Tars 的 `writeString`）→ STRING1/STRING4 */
export function jStr(tag: number, s: string): number[] {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length < 256) return [...jHead(tag, JCE_T.STRING1), buf.length, ...buf]
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length, 0)
  return [...jHead(tag, JCE_T.STRING4), ...len, ...buf]
}

/** 嵌套结构体：STRUCT_BEGIN … STRUCT_END */
export function jStruct(tag: number, body: number[]): number[] {
  return [...jHead(tag, JCE_T.STRUCT_BEGIN), ...body, ...jHead(0, JCE_T.STRUCT_END)]
}

/** 列表：LIST 头 + 长度 + 每个元素（各自带 tag=0 的头） */
export function jList(tag: number, items: number[][]): number[] {
  const out = [...jHead(tag, JCE_T.LIST), ...jInt(0, items.length)]
  items.forEach((item) => {
    out.push(...jHead(0, JCE_T.STRUCT_BEGIN), ...item, ...jHead(0, JCE_T.STRUCT_END))
  })
  return out
}
