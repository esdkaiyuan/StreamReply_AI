import { describe, expect, it } from 'vitest'
import { JCE, bufOf, decodeStruct, intOf, strOf } from '../src/main/adapters/huya/jce'

/**
 * 虎牙的 WUP 编码规则（2026-09-17 从虎牙页面自带的 JceOutputStream/JceInputStream 读出，非推测）：
 *
 * - 类型表：`EN_INT8:0 … EN_STRUCTEND:11, EN_ZERO:12, EN_SIMPLELIST:13`
 *   —— 13 是 **Tars 在 JCE 基础上扩展的 SimpleList**，标准 JCE 只有 0~12，
 *   这正是此前真实帧一条都解不出来的根因（读取器遇到未知类型即中断）。
 * - `writeBytes(tag, v)` = `head(tag, EN_SIMPLELIST)` + `head(0, EN_INT8)` + `writeInt32(0, len)` + 原始字节
 * - 整数**不是 varint**，而是「定长大端 + 类型降级」：
 *   `writeInt8`: 0 → ZERO_TAG（不写值）；否则 head(tag,INT8) + 1B
 *   `writeInt16`: -128..127 → writeInt8；否则 head(tag,INT16) + 2B(BE)
 *   `writeInt32`: -32768..32767 → writeInt16；否则 head(tag,INT32) + 4B(BE)
 * - `writeString` 用 STRING1（head(tag,6) + 1B 长度 + utf8）
 */

/** 按虎牙规则编码一个整数（含类型降级与 ZERO_TAG） */
function encInt(tag: number, value: number): number[] {
  const head = (t: number, ty: number): number[] => (t < 15 ? [(t << 4) | ty] : [(15 << 4) | ty, t])
  if (value === 0) return head(tag, JCE.ZERO)
  if (value >= -128 && value <= 127) return [...head(tag, JCE.BYTE), value & 0xff]
  if (value >= -32768 && value <= 32767)
    return [...head(tag, JCE.SHORT), (value >> 8) & 0xff, value & 0xff]
  return [
    ...head(tag, JCE.INT),
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  ]
}

/** 按虎牙规则编码 byte[]（SIMPLELIST） */
function encBytes(tag: number, data: Buffer): number[] {
  return [
    (tag << 4) | JCE.SIMPLE_LIST,
    0x00, // 元素类型 head：tag0 + INT8
    ...encInt(0, data.length),
    ...data
  ]
}

/** 按虎牙规则编码 string（STRING1） */
function encStr(tag: number, s: string): number[] {
  const b = Buffer.from(s, 'utf8')
  return [(tag << 4) | JCE.STRING1, b.length, ...b]
}

const bytes = (list: number[]): Buffer => Buffer.from(list)

describe('JCE/Tars 类型表（对齐虎牙页面自带实现）', () => {
  it('SimpleList = 13（标准 JCE 只有 0~12）', () => {
    expect(JCE.SIMPLE_LIST).toBe(13)
    expect(JCE.ZERO).toBe(12)
  })
})

describe('SimpleList：byte[] 的读取（虎牙 vData / sMsg 都靠它）', () => {
  it('解出嵌套结构里的 SimpleList 字段（长度走类型降级）', () => {
    // tag1 = 长度很长的 payload（>127 触发 INT16 编码，与真实帧一致）
    const payload = Buffer.alloc(136, 0x41)
    const buf = bytes([...encInt(0, 3), ...encBytes(1, payload)])

    const fields = decodeStruct(buf)
    expect(fields).not.toBeNull()
    expect(intOf(fields!, 0)).toBe(3)
    const got = bufOf(fields!, 1)
    expect(got).not.toBeNull()
    expect(got!.length).toBe(136)
    expect(got!.equals(payload)).toBe(true)
  })

  it('长度 <= 127 时也能解（走 INT8 编码）', () => {
    const payload = Buffer.from('launch', 'utf8')
    const fields = decodeStruct(bytes([...encBytes(1, payload)]))
    expect(bufOf(fields!, 1)!.toString('utf8')).toBe('launch')
  })

  it('长度 0 的 SimpleList 解出空 Buffer 而不是 null', () => {
    const fields = decodeStruct(bytes([...encInt(0, 1), ...encBytes(1, Buffer.alloc(0))]))
    expect(bufOf(fields!, 1)!.length).toBe(0)
  })

  it('元素类型不是 INT8 时安全放弃（不抛异常、不越界）', () => {
    // head(tag1, SIMPLELIST) + 元素类型 head(tag0, INT32=2) —— 非法
    const buf = bytes([0x1d, 0x02, 0x01, 0x00, 0x10])
    expect(decodeStruct(buf)).toBeNull()
  })

  it('声明长度超出剩余字节时放弃，不读出垃圾', () => {
    // 声明 200 字节，实际只有 3 字节
    const buf = bytes([...(0x1d === 0x1d ? [(1 << 4) | JCE.SIMPLE_LIST] : []), 0x00, ...encInt(0, 200), 1, 2, 3])
    expect(decodeStruct(buf)).toBeNull()
  })

  it('SimpleList 之后还能继续解出后续字段（字节边界必须对齐）', () => {
    const payload = Buffer.from('wsLaunch', 'utf8')
    const buf = bytes([...encBytes(1, payload), ...encStr(2, 'HUYA&ZH&2052')])
    const fields = decodeStruct(buf)!

    expect(bufOf(fields, 1)!.toString('utf8')).toBe('wsLaunch')
    expect(strOf(fields, 2)).toBe('HUYA&ZH&2052')
  })
})

describe('MAP：能跳过（此前遇到 MAP 会直接中断整帧解析）', () => {
  it('跳过 MAP 后仍能解出后续字段', () => {
    // tag1 = MAP<string,string>{"a":"b"}，长度为 1
    const map = [
      (1 << 4) | JCE.MAP,
      ...encInt(0, 1),
      ...encStr(0, 'a'),
      ...encStr(0, 'b')
    ]
    const buf = bytes([...map, ...encInt(2, 7)])
    const fields = decodeStruct(buf)!

    expect(intOf(fields, 2)).toBe(7)
  })

  it('空 MAP（长度 0）不消耗额外字节', () => {
    const map = [(1 << 4) | JCE.MAP, ...encInt(0, 0)]
    const fields = decodeStruct(bytes([...map, ...encInt(3, 9)]))!
    expect(intOf(fields, 3)).toBe(9)
  })

  it('MAP 的条目数明显异常时拒绝解析（防止把垃圾当条目数陷进去）', () => {
    // 声明 100000 个条目
    const buf = bytes([(1 << 4) | JCE.MAP, ...encInt(0, 100_000), 0, 0])
    const fields = decodeStruct(buf)
    // 要么整体失败，要么最多留下空结构；绝不能返回带巨额条目的结构
    expect(fields === null || fields.get(1) === undefined || fields.size === 0).toBe(true)
  })
})

describe('整数编码：类型降级与 ZERO_TAG', () => {
  it('值 0 用 ZERO_TAG 表示（不占数值字节）', () => {
    const buf = bytes([...encInt(0, 3), ...encInt(1, 0), ...encInt(2, 5)])
    const fields = decodeStruct(buf)!
    expect(intOf(fields, 0)).toBe(3)
    expect(intOf(fields, 1)).toBe(0)
    expect(intOf(fields, 2)).toBe(5)
  })

  it('大整数用 INT32 定长编码（4 字节大端）', () => {
    const buf = bytes([...encInt(0, 123456)])
    expect(intOf(decodeStruct(buf)!, 0)).toBe(123456)
  })

  it('负数（如 setRequestId(-1)）能正确解出', () => {
    const buf = bytes([...encInt(4, -1)])
    expect(intOf(decodeStruct(buf)!, 4)).toBe(-1)
  })
})

describe('真实 cmdType=22 vData 顶层（回归：读出了错位的整数）', () => {
  // 取自 live.huya.com wuhushenkp 房间的真实帧
  const VDATA = Buffer.from('060f6c6976653a313031363537383735381900010a0117df', 'hex')

  it('字段 0 是频道名字符串，不是整数', () => {
    const f = decodeStruct(VDATA)!
    expect(strOf(f, 0)).toBe('live:1016578758')
  })
})

describe('浮点字段：必须能安全跳过（否则会截断整个结构）', () => {
  it('DOUBLE 字段之后仍能解出后续字段', () => {
    // tag0 = DOUBLE(8 字节)，随后 tag1 = INT
    const buf = bytes([(0 << 4) | JCE.DOUBLE, 0, 0, 0, 0, 0, 0, 0, 0, ...encInt(1, 7)])
    const f = decodeStruct(buf)!
    expect(intOf(f, 1)).toBe(7)
    expect(f.get(0)?.kind).toBe('float')
  })

  it('FLOAT 字段之后仍能解出后续字段', () => {
    const buf = bytes([(0 << 4) | JCE.FLOAT, 0, 0, 0, 0, ...encStr(1, 'abc')])
    const f = decodeStruct(buf)!
    expect(strOf(f, 1)).toBe('abc')
  })

  it('真实形状：ZERO + STRING1 + ZERO + DOUBLE + STRING1 + INT 全都能解出', () => {
    // 取自 uri=6111 的消息体开头
    const buf = bytes([
      ...encInt(0, 0),
      ...encStr(1, '深圳的游客'),
      ...encInt(2, 0),
      (3 << 4) | JCE.DOUBLE,
      0, 0, 0, 0, 0, 0, 0, 0,
      (4 << 4) | JCE.STRING1,
      0,
      ...encInt(5, 1016578758)
    ])
    const f = decodeStruct(buf)!
    expect(strOf(f, 1)).toBe('深圳的游客')
    expect(strOf(f, 4)).toBe('')
    expect(intOf(f, 5)).toBe(1016578758)
  })
})
