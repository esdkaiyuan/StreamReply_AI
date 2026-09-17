/**
 * JCE / Tars 二进制序列化读取器（虎牙弹幕用）。
 *
 * 编码规则：
 * - 每个字段 = [头][值]，头 1 字节：高 4 位是 tag，低 4 位是类型；
 *   若高 4 位为 15，则 tag 用紧随其后的 1 个字节表示
 * - 整型**不是 varint**，而是「定长大端 + 类型降级」：值能塞进更小的类型就用更小的类型，
 *   等于 0 时直接用 ZERO_TAG（不写数值字节）
 * - STRUCT_BEGIN(10) … STRUCT_END(11) 包裹嵌套结构
 * - 类型 13（SIMPLE_LIST）是 Tars 在 JCE 上扩展的，用来编码 `byte[]`
 *
 * 注意：JCE 线上**不区分字符串与二进制**，两者都是 STRING1/STRING4，
 * 所以统一按 Buffer 承载，需要文本时再按 utf8 解释（避免二进制体被往返损坏）。
 *
 * 遇到无法安全跳过的类型会交出已解析部分而非抛异常（坏帧不能带崩整条抓取链路）。
 *
 * 类型表与编码规则取自**虎牙页面自带的 `JceOutputStream`/`JceInputStream`**
 * （2026-09-17 核对，非推测）。
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
  ZERO: 12,
  /**
   * Tars 在 JCE 基础上扩展的类型：`byte[]` 用它编码。
   *
   * ⚠️ 这是虎牙抓取曾经完全失效的根因 —— 标准 JCE 类型表只到 12，
   * 而虎牙的 `WebSocketCommand.vData` / `WSPushMessage.sMsg` 都是 byte[]，
   * 走的是 `writeBytes` = `head(tag,13)` + `head(0,INT8)` + 长度 + 原始字节。
   * 读取器遇到未知类型即中断，于是真实帧一条都解不出来。
   * （类型表取自虎牙页面自带的 `JceOutputStream`/`JceInputStream`，2026-09-17 核对）
   */
  SIMPLE_LIST: 13
} as const

export type JceValue =
  | { kind: 'int'; value: bigint }
  | { kind: 'float'; value: number }
  | { kind: 'bytes'; value: Buffer }
  | { kind: 'struct'; fields: Map<number, JceValue> }
  | { kind: 'list'; items: JceValue[] }
  | { kind: 'map'; entries: Array<{ key: JceValue; value: JceValue }> }

/** MAP 条目数上限：真实协议里远小于此值，超过即视为坏帧（防止把垃圾当条目数陷进去） */
const MAX_MAP_ENTRIES = 10_000

/** 列表元素数上限：同上，避免坏帧里的巨额长度导致长时间空转 */
const MAX_LIST_ITEMS = 100_000

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

export class Reader {
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

  /**
   * 读一个「自身带头的整数」。
   *
   * Tars 的整数是**定长大端 + 类型降级**（`writeInt32` 在值落在 int16 范围时会改用
   * INT16 编码，甚至用 ZERO_TAG 表示 0），所以长度/大小这类字段必须先读头再按类型取宽度。
   */
  readTaggedInt(): number | null {
    const head = this.readHead()
    if (!head) return null
    const value = this.readInt(head.type)
    if (value === null) return null
    return Number(value)
  }

  /**
   * SIMPLE_LIST：`head(tag,13)` + `head(0,INT8)` + 长度（自身带头的整数）+ 原始字节。
   * 解出来直接当 `bytes` 用 —— 虎牙的 `vData` / `sMsg` 都是它。
   */
  readSimpleList(): Buffer | null {
    const elem = this.readHead()
    if (!elem || elem.type !== JCE.BYTE) return null
    const len = this.readTaggedInt()
    if (len === null || len < 0 || this.pos + len > this.end) return null
    const out = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  /** MAP：`head(tag,8)` + 条目数 + (键头,键,值头,值) × 条目数 */
  readMap(): Array<{ key: JceValue; value: JceValue }> | null {
    const size = this.readTaggedInt()
    if (size === null || size < 0 || size > MAX_MAP_ENTRIES) return null
    const entries: Array<{ key: JceValue; value: JceValue }> = []
    for (let i = 0; i < size; i += 1) {
      const keyHead = this.readHead()
      if (!keyHead) return null
      const key = this.readValue(keyHead.type)
      if (!key) return null
      const valueHead = this.readHead()
      if (!valueHead) return null
      const value = this.readValue(valueHead.type)
      if (!value) return null
      entries.push({ key, value })
    }
    return entries
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
    if (type === JCE.MAP) return this.readMap() !== null
    if (type === JCE.SIMPLE_LIST) return this.readSimpleList() !== null

    return false // 其余未知类型无法安全跳过
  }

  /**
   * 列表：`head(tag,9)` + **长度（带头整数）** + 元素 × 长度。
   *
   * 每个元素自己带 head（虎牙的 `writeVector` 用 tag=0 写元素，见其实现原文：
   * `writeTo(tag, EN_LIST); writeInt32(0, len); for(…) elem._write(this, 0, v[i])`）。
   *
   * ⚠️ 这里**不能**用「遇到 `tag=0 且 type=BYTE` 就当结束」的启发式：
   * 长度字段 `writeInt32(0, 1)` 在值 ≤127 时恰好编码成 `00 01`，
   * 会被那个启发式误判成结束标记，导致整条流错位
   * （2026-09-17 实测：cmdType=22 的 vData 因此把频道名字段覆盖成整数 2561）。
   */
  readList(): JceValue[] | null {
    const size = this.readTaggedInt()
    if (size === null || size < 0 || size > MAX_LIST_ITEMS) return null
    const items: JceValue[] = []
    for (let i = 0; i < size; i += 1) {
      const head = this.readHead()
      if (!head) return null
      const value = this.readValue(head.type)
      if (!value) return null
      items.push(value)
    }
    return items
  }

  readValue(type: number): JceValue | null {
    // 浮点数：虎牙协议里基本用不到，但**必须能安全跳过**。
    // 否则 readInt 返回 null 且不移动游标 → readValue 也返回 null →
    // readFields 误判为坏帧而提前收工，把后面所有字段一起丢掉
    // （2026-09-17 实测：uri=6111 的 121 字节只解出前 3 个字段）。
    if (type === JCE.FLOAT || type === JCE.DOUBLE) {
      const size = isFixed(type)
      if (size === null || this.pos + size > this.end) return null
      const value = type === JCE.FLOAT ? this.buf.readFloatBE(this.pos) : this.buf.readDoubleBE(this.pos)
      this.pos += size
      return { kind: 'float', value }
    }

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

    // byte[]（虎牙的 vData / sMsg）——解出来就是 bytes，可直接 bufOf 取用
    if (type === JCE.SIMPLE_LIST) {
      const value = this.readSimpleList()
      return value === null ? null : { kind: 'bytes', value }
    }

    if (type === JCE.MAP) {
      const entries = this.readMap()
      return entries === null ? null : { kind: 'map', entries }
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
