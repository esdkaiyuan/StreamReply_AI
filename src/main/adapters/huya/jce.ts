/**
 * JCE / Tars 二进制序列化读取器（虎牙弹幕用）。
 *
 * 编码规则：
 * - 每个字段 = [头][值]，头 1 字节：高 4 位是 tag，低 4 位是类型；
 *   若高 4 位为 15，则 tag 用紧随其后的 1 个字节表示
 * - 多字节整数一律**大端**
 * - STRUCT_BEGIN(10) … STRUCT_END(11) 包裹嵌套结构
 *
 * 注意：JCE 线上**不区分字符串与二进制**，两者都是 STRING1/STRING4，
 * 所以统一按 Buffer 承载，需要文本时再按 utf8 解释（避免二进制体被往返损坏）。
 *
 * 遇到未支持的类型（MAP 等）无法安全跳过，会交出已解析部分而非抛异常。
 */

export const JCE = {
  BYTE: 0,
  SHORT: 1,
  INT: 2,
  LONG: 3,
  FLOAT: 4,
  DOUBLE: 5,
  STRING1: 6,
  STRING4: 7,
  MAP: 8,
  LIST: 9,
  STRUCT_BEGIN: 10,
  STRUCT_END: 11,
  ZERO: 12
} as const

export type JceValue =
  | { kind: 'int'; value: bigint }
  | { kind: 'bytes'; value: Buffer }
  | { kind: 'struct'; fields: Map<number, JceValue> }
  | { kind: 'list'; items: JceValue[] }

export interface JceHead {
  tag: number
  type: number
}

function isFixed(type: number): number | null {
  switch (type) {
    case 0:
      return 1
    case 1:
      return 2
    case 2:
    case 4:
      return 4
    case 3:
    case 5:
      return 8
    default:
      return null
  }
}

class Reader {
  pos = 0

  constructor(
    private buf: Buffer,
    private end: number = buf.length
  ) {}

  readHead(): JceHead | null {
    if (this.pos >= this.end) return null
    const b = this.buf[this.pos++]
    let tag = (b & 0xf0) >> 4
    const type = b & 0x0f
    if (tag === 15) {
      if (this.pos >= this.end) return null
      tag = this.buf[this.pos++]
    }
    return { tag, type }
  }

  /** 定长整型读取；类型不符则不移动游标并返回 null */
  readInt(type: number): bigint | null {
    if (type === JCE.ZERO) return 0n
    const size = isFixed(type)
    if (size === null || this.pos + size > this.end) return null
    if (type === JCE.BYTE) {
      const v = this.buf.readInt8(this.pos)
      this.pos += 1
      return BigInt(v)
    }
    if (type === JCE.SHORT) {
      const v = this.buf.readInt16BE(this.pos)
      this.pos += 2
      return BigInt(v)
    }
    if (type === JCE.INT) {
      const v = this.buf.readInt32BE(this.pos)
      this.pos += 4
      return BigInt(v)
    }
    if (type === JCE.LONG) {
      const v = this.buf.readBigInt64BE(this.pos)
      this.pos += 8
      return v
    }
    return null // FLOAT / DOUBLE 用不到，交给 skipValue
  }

  /** STRING1/STRING4 读取为原始字节 */
  readBytes(type: number): Buffer | null {
    let len: number
    if (type === JCE.STRING1) {
      if (this.pos + 1 > this.end) return null
      len = this.buf.readUInt8(this.pos)
      this.pos += 1
    } else if (type === JCE.STRING4) {
      if (this.pos + 4 > this.end) return null
      len = this.buf.readUInt32BE(this.pos)
      this.pos += 4
    } else {
      return null
    }
    if (this.pos + len > this.end) return null
    const out = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  skipValue(type: number): boolean {
    if (type === JCE.ZERO) return true

    const size = isFixed(type)
    if (size !== null) {
      this.pos += size
      return this.pos <= this.end
    }

    if (type === JCE.STRING1 || type === JCE.STRING4) {
      return this.readBytes(type) !== null
    }

    if (type === JCE.STRUCT_BEGIN) {
      for (;;) {
        const head = this.readHead()
        if (!head) return false
        if (head.type === JCE.STRUCT_END) return true
        if (!this.skipValue(head.type)) return false
      }
    }

    if (type === JCE.LIST) return this.readList() !== null

    return false // MAP 等未支持类型
  }

  /** 列表：逐个读「头 + 值」，遇到 STRUCT_END 或数据耗尽即结束 */
  readList(): JceValue[] | null {
    const items: JceValue[] = []
    for (;;) {
      const head = this.readHead()
      if (!head) break
      if (head.type === JCE.STRUCT_END) break
      // Tars 列表以「tag=0 且 type=BYTE」的空头收尾（元素本身的 type 是 STRUCT_BEGIN）
      if (head.tag === 0 && head.type === JCE.BYTE) break
      const value = this.readValue(head.type)
      if (!value) break
      items.push(value)
    }
    return items
  }

  readValue(type: number): JceValue | null {
    const asInt = this.readInt(type)
    if (asInt !== null) return { kind: 'int', value: asInt }

    const asBytes = this.readBytes(type)
    if (asBytes !== null) return { kind: 'bytes', value: asBytes }

    if (type === JCE.STRUCT_BEGIN) {
      return { kind: 'struct', fields: this.readFields() }
    }

    if (type === JCE.LIST) {
      const items = this.readList()
      return items === null ? null : { kind: 'list', items }
    }

    return null
  }

  /** 读取一个结构体，直到 STRUCT_END 或数据耗尽；不抛异常 */
  readFields(): Map<number, JceValue> {
    const fields = new Map<number, JceValue>()
    for (;;) {
      const head = this.readHead()
      if (!head) return fields
      if (head.type === JCE.STRUCT_END) return fields
      const value = this.readValue(head.type)
      if (!value) return fields
      fields.set(head.tag, value)
    }
  }
}

/** 解析一段 JCE 结构体字节；无有效字段返回 null */
export function decodeStruct(buf: Buffer): Map<number, JceValue> | null {
  if (buf.length === 0) return null
  const fields = new Reader(buf).readFields()
  return fields.size > 0 ? fields : null
}

export function intOf(fields: Map<number, JceValue>, tag: number): number {
  const v = fields.get(tag)
  return v && v.kind === 'int' ? Number(v.value) : 0
}

/** 文本字段按 utf8 解释 */
export function strOf(fields: Map<number, JceValue>, tag: number): string {
  const v = fields.get(tag)
  return v && v.kind === 'bytes' ? v.value.toString('utf8') : ''
}

export function bufOf(fields: Map<number, JceValue>, tag: number): Buffer | null {
  const v = fields.get(tag)
  return v && v.kind === 'bytes' ? v.value : null
}

export function structOf(fields: Map<number, JceValue>, tag: number): Map<number, JceValue> | null {
  const v = fields.get(tag)
  return v && v.kind === 'struct' ? v.fields : null
}

export function listOf(fields: Map<number, JceValue>, tag: number): JceValue[] {
  const v = fields.get(tag)
  return v && v.kind === 'list' ? v.items : []
}
