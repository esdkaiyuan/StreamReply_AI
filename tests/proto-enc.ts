/** 测试用的极简 protobuf 编码器，用于构造抖音帧字节 */

export function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}

export function varintBig(n: bigint): number[] {
  const out: number[] = []
  let v = n
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  out.push(Number(v))
  return out
}

export function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire)
}

export function lenDelim(bytes: number[]): number[] {
  return [...varint(bytes.length), ...bytes]
}

export function str(s: string): number[] {
  return lenDelim([...Buffer.from(s, 'utf8')])
}

export function num(field: number, value: number): number[] {
  return [...tag(field, 0), ...varint(value)]
}

export function text(field: number, value: string): number[] {
  return [...tag(field, 2), ...str(value)]
}

export function bytes(field: number, value: number[]): number[] {
  return [...tag(field, 2), ...lenDelim(value)]
}

export function msg(field: number, body: number[]): number[] {
  return [...tag(field, 2), ...lenDelim(body)]
}
