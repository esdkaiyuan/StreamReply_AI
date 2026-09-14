import { bufOf, decodeStruct, intOf, listOf } from './jce'

/** 虎牙消息 Uri（取自维护中的实现，非推测） */
export const HUYA_URI = {
  /** 弹幕 */
  CHAT: 1400,
  /** 在线人数 / 人气 */
  ONLINE: 8006
} as const

/** WebSocketCommand 的 iCmdType */
export const HUYA_CMD = {
  MSG_PUSH: 7,
  MSG_PUSH_V2: 22
} as const

export interface HuyaMessage {
  uri: number
  body: Buffer
}

/**
 * WebSocketCommand { 0: iCmdType (INT), 1: data (byte[]) }
 * 进房包与推送包共用这个外层结构。
 */
export function parseWebSocketCommand(raw: Buffer): { cmdType: number; data: Buffer } | null {
  const cmd = decodeStruct(raw)
  if (!cmd) return null
  const data = bufOf(cmd, 1)
  if (!data) return null
  return { cmdType: intOf(cmd, 0), data }
}

/**
 * 一帧 WS 数据 → 若干条「Uri + 消息体」。
 * - iCmdType=7：HYPushMessage { 0:PushType, 1:Uri, 2:Msg, 3:ProtocolType }
 * - iCmdType=22：HYPushMessageV2 { 0:GroupId, 1:MsgItem[] }，
 *   MsgItem { 0:Uri, 1:Msg, 2:MsgId }（该通道多为系统/AI 弹幕，尽力解析）
 * 其余 iCmdType（心跳、注册响应等）返回空数组。
 */
export function parseHuyaFrame(raw: Buffer): HuyaMessage[] {
  const cmd = parseWebSocketCommand(raw)
  if (!cmd) return []

  if (cmd.cmdType === HUYA_CMD.MSG_PUSH) {
    const push = decodeStruct(cmd.data)
    if (!push) return []
    const body = bufOf(push, 2)
    return body ? [{ uri: intOf(push, 1), body }] : []
  }

  if (cmd.cmdType === HUYA_CMD.MSG_PUSH_V2) {
    const v2 = decodeStruct(cmd.data)
    if (!v2) return []
    const out: HuyaMessage[] = []
    for (const item of listOf(v2, 1)) {
      if (item.kind !== 'struct') continue
      const body = bufOf(item.fields, 1)
      if (body) out.push({ uri: intOf(item.fields, 0), body })
    }
    return out
  }

  return []
}
