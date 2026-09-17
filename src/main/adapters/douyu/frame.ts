/**
 * 斗鱼弹幕二进制帧拆包。
 *
 * ⚠️ 真实协议（2026-09-17 从 danmuproxy.douyu.com:8502 抓帧核对，与旧假设有三处差异）：
 *
 * 单包结构（小端）：
 *   [0:4]   length = **STT 体长 + 9**
 *   [4:8]   length 重复一次
 *   [8:10]  类型标识：客户端→服务端 = 0x02b1，服务端→客户端 = **0x02b2**
 *   [10]    加密标志（0）
 *   [11]    保留位（0）
 *   [12:12+len-9] STT 文本
 *   [尾]    0x00 填充
 *
 * 与旧假设的差异（都是实测踩出来的）：
 * 1. 长度语义是「体长 + 9」，**包总长 = length + 4**（旧实现按「体长」推进会错位丢包）；
 * 2. 接收方向的类型是 0x02b2 —— 只认 0x02b1 会在第一个真实帧就 break；
 * 3. **一条 WS 消息可粘连多个包**（实测 817B = 564B chatmsg + 245B），必须按
 *    「offset += length + 4」推进。
 */

/** 客户端→服务端（发送注册/心跳/进房包用） */
export const DOUYU_HEADER = 0x02b1
/** 服务端→客户端（弹幕/进场/礼物推送） */
export const DOUYU_HEADER_SERVER = 0x02b2

const HEADER_LEN = 12
/** 长度字段 = 体长 + 9 */
const LENGTH_OVERHEAD = 9

/** 从一条 WS 消息里拆出所有 STT 报文；坏帧安全停止并返回已拆出的部分 */
export function splitPackets(buf: Buffer): string[] {
  const out: string[] = []
  let offset = 0
  while (offset + HEADER_LEN <= buf.length) {
    const length = buf.readUInt32LE(offset)
    const marker = buf.readUInt16LE(offset + 8)
    if (marker !== DOUYU_HEADER && marker !== DOUYU_HEADER_SERVER) break
    const bodyLength = length - LENGTH_OVERHEAD
    // 整条消息 = 4B 第二个长度字段 + 本包；体长非法即视为坏帧
    if (bodyLength < 0 || offset + 4 + length > buf.length) break
    const body = buf.subarray(offset + HEADER_LEN, offset + HEADER_LEN + bodyLength)
    out.push(body.toString('utf8').replace(/\0+$/, ''))
    offset += length + 4
  }
  return out
}

/** 组装一条斗鱼帧（发送侧用，测试也用它构造数据） */
export function buildPacket(body: string): Buffer {
  const payload = Buffer.from(body, 'utf8')
  const length = payload.length + LENGTH_OVERHEAD
  const head = Buffer.alloc(HEADER_LEN)
  head.writeUInt32LE(length, 0)
  head.writeUInt32LE(length, 4)
  head.writeUInt16LE(DOUYU_HEADER, 8)
  head.writeUInt8(0, 10)
  head.writeUInt8(0, 11)
  return Buffer.concat([head, payload, Buffer.from([0])])
}
