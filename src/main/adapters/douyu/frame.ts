/**
 * 斗鱼弹幕二进制帧拆包。
 *
 * 单帧结构（小端）：
 *   [0:4]   bodyLength  内容字节数
 *   [4:8]   bodyLength  重复一次
 *   [8:10]  0x02B1 (689) 固定头部标识
 *   [10]    0x00 加密标志
 *   [11]    0x00 保留位
 *   [12:12+bodyLength]  STT 文本（UTF-8，尾部可能带 \0）
 *   [12+bodyLength]     0x00 填充字节
 */

/** 固定头部标识，用于校验帧合法性（避免把其他二进制流误当斗鱼帧） */
export const DOUYU_HEADER = 0x02b1

const HEADER_LEN = 12

/** 从一条 WS 消息里拆出所有 STT 报文；坏帧安全停止并返回已拆出的部分 */
export function splitPackets(buf: Buffer): string[] {
  const out: string[] = []
  let offset = 0
  while (offset + HEADER_LEN <= buf.length) {
    const bodyLength = buf.readUInt32LE(offset)
    const marker = buf.readUInt16LE(offset + 8)
    if (marker !== DOUYU_HEADER) break
    if (bodyLength <= 0 || offset + HEADER_LEN + bodyLength > buf.length) break
    const body = buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + bodyLength)
    out.push(body.toString('utf8').replace(/\0+$/, ''))
    offset += HEADER_LEN + bodyLength + 1 // 末尾 1 字节填充
  }
  return out
}

/** 组装一条斗鱼帧（发送侧用，测试也用它构造数据） */
export function buildPacket(body: string): Buffer {
  const payload = Buffer.from(body, 'utf8')
  const head = Buffer.alloc(HEADER_LEN)
  head.writeUInt32LE(payload.length, 0)
  head.writeUInt32LE(payload.length, 4)
  head.writeUInt16LE(DOUYU_HEADER, 8)
  head.writeUInt8(0, 10)
  head.writeUInt8(0, 11)
  return Buffer.concat([head, payload, Buffer.from([0])])
}
