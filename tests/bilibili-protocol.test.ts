import { describe, expect, it } from 'vitest'
import { brotliCompressSync } from 'zlib'
import { OP, buildPacket, splitPackets, decodeBody } from '../src/main/adapters/bilibili/protocol'

describe('bilibili protocol', () => {
  it('splitPackets 解析单帧头字段', () => {
    const frame = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"x"}'))
    const packets = splitPackets(frame)
    expect(packets).toHaveLength(1)
    expect(packets[0].op).toBe(OP.MESSAGE)
    expect(packets[0].protover).toBe(0)
    expect(packets[0].body.toString()).toBe('{"cmd":"x"}')
  })

  it('splitPackets 解析串联多帧', () => {
    const a = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"a"}'))
    const b = buildPacket(OP.HEARTBEAT_REPLY, 1, Buffer.from([0, 0, 0, 100]))
    const packets = splitPackets(Buffer.concat([a, b]))
    expect(packets).toHaveLength(2)
    expect(packets[1].op).toBe(OP.HEARTBEAT_REPLY)
    expect(packets[1].body.readUInt32BE(0)).toBe(100)
  })

  it('decodeBody 解压 protover=3 brotli 并拆出子帧 body', () => {
    const inner1 = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"DANMU_MSG"}'))
    const inner2 = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"INTERACT_WORD"}'))
    const outer = buildPacket(OP.MESSAGE, 3, brotliCompressSync(Buffer.concat([inner1, inner2])))
    const bodies = decodeBody(splitPackets(outer)[0])
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[0].toString()).cmd).toBe('DANMU_MSG')
  })

  it('decodeBody protover=0 原样返回', () => {
    const frame = buildPacket(OP.MESSAGE, 0, Buffer.from('[1,2]'))
    expect(decodeBody(splitPackets(frame)[0])).toHaveLength(1)
  })

  it('截断的帧尾被安全忽略', () => {
    const frame = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"a"}'))
    const truncated = Buffer.concat([frame, Buffer.from([0, 0])])
    expect(splitPackets(truncated)).toHaveLength(1)
  })

  it('protover=3 携带非法 brotli 数据时安全返回空数组', () => {
    const frame = buildPacket(OP.MESSAGE, 3, Buffer.from('not-brotli-data'))
    expect(decodeBody(splitPackets(frame)[0])).toEqual([])
  })

  it('headerLen 异常（>packetLen 或 <16）的帧被安全忽略', () => {
    // 手工构造 headerLen=65535 的帧
    const head = Buffer.alloc(16)
    head.writeUInt32BE(16, 0)
    head.writeUInt16BE(65535, 4)
    head.writeUInt16BE(0, 6)
    head.writeUInt32BE(5, 8)
    const evil = Buffer.concat([head])
    expect(splitPackets(evil)).toEqual([])
  })
})
