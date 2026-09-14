import { describe, expect, it } from 'vitest'
import { buildPacket, splitPackets } from '../src/main/adapters/douyu/frame'
import { mapDouyuMessage } from '../src/main/adapters/douyu/mapper'
import { escapeSttValue, parseStt, serializeStt } from '../src/main/adapters/douyu/stt'
import type { DanmakuMessage } from '../src/shared/types'

describe('douyu STT', () => {
  it('解析基础键值对', () => {
    expect(parseStt('type@=chatmsg/nn@=用户/txt@=hello/')).toEqual({
      type: 'chatmsg',
      nn: '用户',
      txt: 'hello'
    })
  })

  it('@S 还原为 /、@A 还原为 @（顺序敏感）', () => {
    // 原文含 / 时序列化为 @S
    expect(parseStt('txt@=a@Sb/')).toEqual({ txt: 'a/b' })
    // 原文含 @ 时序列化为 @A
    expect(parseStt('txt@=a@Ab/')).toEqual({ txt: 'a@b' })
    // 原文含字面量 "@S" → 序列化为 "@AS"，解码后必须还是 "@S" 而不是 "/"
    expect(parseStt('txt@=a@ASb/')).toEqual({ txt: 'a@Sb' })
  })

  it('序列化与反序列化互为逆运算', () => {
    const src = { type: 'chatmsg', nn: '小明', txt: '弹幕/带@符号' }
    expect(parseStt(serializeStt(src))).toEqual(src)
    expect(escapeSttValue('a/@b')).toBe('a@S@Ab')
  })

  it('坏输入返回已解析部分，不抛异常', () => {
    expect(() => parseStt('乱码没有分隔符')).not.toThrow()
    expect(parseStt('')).toEqual({})
    expect(parseStt('type@=mrkl/\0\0')).toEqual({ type: 'mrkl' })
  })
})

describe('douyu frame', () => {
  it('单帧拆包并去掉尾部 \\0', () => {
    const body = 'type@=chatmsg/nn@=小明/txt@=主播好/'
    expect(splitPackets(buildPacket(body))).toEqual([body])
  })

  it('多帧串联一次性拆出', () => {
    const a = 'type@=chatmsg/txt@=1/'
    const b = 'type@=uenter/nn@=2/'
    const buf = Buffer.concat([buildPacket(a), buildPacket(b)])
    expect(splitPackets(buf)).toEqual([a, b])
  })

  it('头部标识不符或截断时安全停止，交出已拆出的部分', () => {
    expect(splitPackets(Buffer.from([1, 2, 3, 4]))).toEqual([])
    const good = buildPacket('type@=mrkl/')
    const bad = Buffer.concat([good, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])])
    expect(splitPackets(bad)).toEqual(['type@=mrkl/'])
  })
})

describe('douyu mapper', () => {
  const roomId = '9999'
  const asDanmaku = (v: DanmakuMessage | null): DanmakuMessage => v as DanmakuMessage

  it('chatmsg → chat（含 uid/头像/粉丝牌等级）', () => {
    const m = asDanmaku(
      mapDouyuMessage(
        {
          type: 'chatmsg',
          nn: '小明',
          txt: '主播好呀',
          uid: '12345',
          ic: 'https://apic.douyucdn.cn/avatar.png',
          bl: '12'
        },
        roomId
      )
    )
    expect(m.type).toBe('chat')
    expect(m.content).toBe('主播好呀')
    expect(m.user.nickname).toBe('小明')
    expect(m.user.uid).toBe('12345')
    expect(m.user.avatar).toContain('avatar.png')
    expect(m.user.medalLevel).toBe(12)
    expect(m.platform).toBe('douyu')
    expect(m.roomId).toBe(roomId)
  })

  it('uenter → enter', () => {
    const m = asDanmaku(mapDouyuMessage({ type: 'uenter', nn: '新观众', uid: '7' }, roomId))
    expect(m.type).toBe('enter')
    expect(m.user.nickname).toBe('新观众')
  })

  it('dgb → gift（礼物名只有 id，不臆造名称与价格）', () => {
    const m = asDanmaku(
      mapDouyuMessage({ type: 'dgb', nn: '土豪', gfid: '824', gfcnt: '5', uid: '8' }, roomId)
    )
    expect(m.type).toBe('gift')
    expect(m.gift?.name).toBe('礼物#824')
    expect(m.gift?.count).toBe(5)
    expect(m.gift?.price).toBe(0)
  })

  it('心跳与未知 type 返回 null；空弹幕内容被丢弃', () => {
    expect(mapDouyuMessage({ type: 'mrkl' }, roomId)).toBeNull()
    expect(mapDouyuMessage({ type: 'loginres' }, roomId)).toBeNull()
    expect(mapDouyuMessage({ type: 'chatmsg', txt: '' }, roomId)).toBeNull()
    expect(mapDouyuMessage({}, roomId)).toBeNull()
  })

  it('缺 uid 时昵称仍可回退为未知用户', () => {
    const m = asDanmaku(mapDouyuMessage({ type: 'chatmsg', txt: 'hi' }, roomId))
    expect(m.user.nickname).toBe('未知用户')
    expect(m.user.uid).toBe('')
  })
})
