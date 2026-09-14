import { describe, expect, it } from 'vitest'
import { parseHuyaFrame, parseWebSocketCommand, HUYA_CMD, HUYA_URI } from '../src/main/adapters/huya/frame'
import { decodeStruct, intOf, strOf, structOf } from '../src/main/adapters/huya/jce'
import { mapHuyaMessage } from '../src/main/adapters/huya/mapper'
import { jBytes, jInt, jList, jLong, jStr, jStruct } from './jce-enc'

/** HYSender { 0: Uid, 1: Lmid, 2: NickName, 3: Gender } */
function sender(uid: number, nick: string): number[] {
  return [...jLong(0, uid), ...jLong(1, 0), ...jStr(2, nick), ...jInt(3, 0)]
}

/** HYMessage { 0: UserInfo, 3: Content, 6: BulletFormat } */
function chatBody(uid: number, nick: string, content: string): Buffer {
  return Buffer.from([
    ...jStruct(0, sender(uid, nick)),
    ...jStr(3, content),
    ...jStruct(6, [...jInt(0, 16777215), ...jInt(1, 4)])
  ])
}

/** HYPushMessage { 0: PushType, 1: Uri, 2: Msg, 3: ProtocolType } */
function pushMessage(uri: number, msg: Buffer): Buffer {
  return Buffer.from([...jInt(0, 0), ...jLong(1, uri), ...jBytes(2, msg), ...jInt(3, 0)])
}

/** WebSocketCommand { 0: iCmdType, 1: data } */
function wsCommand(cmdType: number, data: number[]): Buffer {
  return Buffer.from([...jInt(0, cmdType), ...jBytes(1, Buffer.from(data))])
}

describe('JCE reader', () => {
  it('读取整型 / 长整型 / 字符串与嵌套结构', () => {
    const buf = Buffer.from([
      ...jInt(0, 42),
      ...jLong(1, 1400),
      ...jStr(2, '你好'),
      ...jStruct(3, [...jInt(0, 7), ...jStr(2, '小明')])
    ])
    const fields = decodeStruct(buf)!
    expect(intOf(fields, 0)).toBe(42)
    expect(intOf(fields, 1)).toBe(1400)
    expect(strOf(fields, 2)).toBe('你好')
    const nested = structOf(fields, 3)!
    expect(intOf(nested, 0)).toBe(7)
    expect(strOf(nested, 2)).toBe('小明')
  })

  it('ZERO 类型不占数据字节', () => {
    const buf = Buffer.from([...jInt(0, 0), ...jStr(1, 'after')])
    const fields = decodeStruct(buf)!
    expect(intOf(fields, 0)).toBe(0)
    expect(strOf(fields, 1)).toBe('after')
  })

  it('tag >= 15 时用扩展字节表示', () => {
    const buf = Buffer.from([...jInt(20, 123)])
    expect(intOf(decodeStruct(buf)!, 20)).toBe(123)
  })

  it('长字符串走 STRING4 且能正确读回', () => {
    const long = 'x'.repeat(300)
    const fields = decodeStruct(Buffer.from([...jStr(0, long)]))!
    expect(strOf(fields, 0)).toBe(long)
  })

  it('二进制体不因 utf8 往返而损坏', () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41])
    const fields = decodeStruct(Buffer.from([...jBytes(0, raw)]))!
    const v = fields.get(0)!
    expect(v.kind).toBe('bytes')
    if (v.kind === 'bytes') expect([...v.value]).toEqual([...raw])
  })

  it('截断数据不抛异常，返回已解析部分', () => {
    const buf = Buffer.from([...jInt(0, 5), ...[0x26, 0xff]]) // 第二个字段声明了 255 字节却只有 1 字节
    expect(() => decodeStruct(buf)).not.toThrow()
    expect(intOf(decodeStruct(buf)!, 0)).toBe(5)
    expect(decodeStruct(Buffer.alloc(0))).toBeNull()
  })
})

describe('huya frame', () => {
  it('iCmdType=7 解出 Uri 与消息体', () => {
    const body = chatBody(123, '小明', '主播好')
    const raw = wsCommand(HUYA_CMD.MSG_PUSH, [...pushMessage(HUYA_URI.CHAT, body)])
    const messages = parseHuyaFrame(raw)
    expect(messages).toHaveLength(1)
    expect(messages[0].uri).toBe(HUYA_URI.CHAT)
    expect(messages[0].body.toString('utf8')).toContain('主播好')
  })

  it('8006 在线人数的消息体是单个 LONG', () => {
    const raw = wsCommand(HUYA_CMD.MSG_PUSH, [
      ...pushMessage(HUYA_URI.ONLINE, Buffer.from([...jLong(0, 88888)]))
    ])
    expect(parseHuyaFrame(raw)[0].uri).toBe(HUYA_URI.ONLINE)
  })

  it('iCmdType=22 从 MsgItem 列表逐条解出', () => {
    const item = [...jLong(0, HUYA_URI.CHAT), ...jBytes(1, chatBody(9, '甲', 'V2消息'))]
    const v2 = [...jStr(0, 'group'), ...jList(1, [item])]
    const raw = wsCommand(HUYA_CMD.MSG_PUSH_V2, v2)
    const messages = parseHuyaFrame(raw)
    expect(messages).toHaveLength(1)
    expect(messages[0].uri).toBe(HUYA_URI.CHAT)
  })

  it('心跳等其它 iCmdType 返回空数组', () => {
    expect(parseHuyaFrame(wsCommand(6, [...jLong(0, 1)]))).toEqual([])
    expect(parseHuyaFrame(Buffer.from([1, 2, 3]))).toEqual([])
    expect(parseWebSocketCommand(Buffer.alloc(0))).toBeNull()
  })
})

describe('huya mapper', () => {
  const roomId = '660000'

  it('1400 → chat（昵称 / uid / 内容）', () => {
    const mapped = mapHuyaMessage(HUYA_URI.CHAT, chatBody(123456, '小明', '主播好呀'), roomId)
    expect(mapped?.kind).toBe('danmaku')
    if (mapped?.kind !== 'danmaku') throw new Error('expected danmaku')
    expect(mapped.message.type).toBe('chat')
    expect(mapped.message.content).toBe('主播好呀')
    expect(mapped.message.user.nickname).toBe('小明')
    expect(mapped.message.user.uid).toBe('123456')
    expect(mapped.message.platform).toBe('huya')
  })

  it('8006 → online', () => {
    const mapped = mapHuyaMessage(HUYA_URI.ONLINE, Buffer.from([...jLong(0, 5200)]), roomId)
    expect(mapped).toEqual({ kind: 'online', count: 5200 })
  })

  it('空内容 / 未知 Uri / 坏数据返回 null', () => {
    expect(mapHuyaMessage(HUYA_URI.CHAT, chatBody(1, '甲', ''), roomId)).toBeNull()
    expect(mapHuyaMessage(9999, Buffer.from([...jInt(0, 1)]), roomId)).toBeNull()
    expect(mapHuyaMessage(HUYA_URI.CHAT, Buffer.alloc(0), roomId)).toBeNull()
  })
})
