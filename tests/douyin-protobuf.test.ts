import { describe, expect, it } from 'vitest'
import {
  asBigInt,
  asBigString,
  asBytes,
  asMessage,
  asNumber,
  asString,
  decodeMessage
} from '../src/main/adapters/protobuf'

/** ---- protobuf 编码辅助，用于构造测试字节 ---- */
function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}
function varintBig(n: bigint): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return out
}
function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire)
}
function lenDelim(bytes: number[]): number[] {
  return [...varint(bytes.length), ...bytes]
}
function str(s: string): number[] {
  return lenDelim([...Buffer.from(s, 'utf8')])
}
function num(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)]
}
function text(field: number, value: string): number[] {
  return [...tag(field, 2), ...str(value)]
}
function msg(field: number, body: number[]): number[] {
  return [...tag(field, 2), ...lenDelim(body)]
}

describe('douyin protobuf decoder', () => {
  it('解析 varint / string / 嵌套消息', () => {
    // ChatMessage { user { nickName = "小明" }, content = "你好" }
    const user = [...text(3, '小明'), ...num(1, 12345)]
    const buf = Buffer.from([...msg(2, user), ...text(3, '你好'), ...num(4, 1)])

    const fields = decodeMessage(buf)
    expect(asString(fields, 3)).toBe('你好')
    expect(asNumber(fields, 4)).toBe(1)

    const u = asMessage(fields, 2)
    expect(u).not.toBeNull()
    expect(asString(u!, 3)).toBe('小明')
    expect(asNumber(u!, 1)).toBe(12345)
  })

  it('跳过 fixed32 / fixed64，不影响后续字段', () => {
    const buf = Buffer.from([
      ...tag(1, 5), 1, 2, 3, 4, // fixed32
      ...tag(2, 1), 1, 2, 3, 4, 5, 6, 7, 8, // fixed64
      ...text(3, 'after')
    ])
    expect(asString(decodeMessage(buf), 3)).toBe('after')
  })

  it('重复字段按出现顺序保留', () => {
    const buf = Buffer.from([...text(1, 'a'), ...text(1, 'b')])
    const fields = decodeMessage(buf)
    expect(fields.get(1)?.length).toBe(2)
    expect(asString(fields, 1)).toBe('a')
  })

  it('二进制字段按原样返回（gzip payload 场景）', () => {
    const raw = [0x1f, 0x8b, 0x08, 0x00, 0xff]
    const buf = Buffer.from([...tag(8, 2), ...lenDelim(raw)])
    expect([...(asBytes(decodeMessage(buf), 8) ?? [])]).toEqual(raw)
  })

  it('超长/截断的输入不抛异常', () => {
    expect(() => decodeMessage(Buffer.from([0x1a, 0xff, 0xff]))).not.toThrow()
    expect(decodeMessage(Buffer.from([0x1a, 0xff, 0xff])).size).toBe(0)
    expect(decodeMessage(Buffer.alloc(0)).size).toBe(0)
  })

  it('超过 2^53 的 uint64 用 BigInt 精确还原（用户 id 场景）', () => {
    const big = 7181868093256338235n
    const buf = Buffer.from([...tag(1, 0), ...varintBig(big)])
    expect(asBigInt(decodeMessage(buf), 1)).toBe(big)
    expect(asBigString(decodeMessage(buf), 1)).toBe('7181868093256338235')
  })
})
