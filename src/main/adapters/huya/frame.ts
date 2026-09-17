import { bufOf, decodeStruct, intOf, listOf } from './jce'

/** 虎牙消息 Uri（取自维护中的实现，非推测） */
export const HUYA_URI = {
  /** 弹幕 */
  CHAT: 1400,
  /** 在线人数 / 人气 */
  ONLINE: 8006
} as const

/** WebSocketCommand 的 iCmdType（完整枚举见虎牙页面自带的 `EWebSocketCommandType`） */
export const HUYA_CMD = {
  /** 客户端发起 WUP 请求（如取配置、拉历史） */
  WUP_REQ: 3,
  /** 服务端 WUP 响应 */
  WUP_RSP: 4,
  /** 服务端消息推送 —— 弹幕/礼物/人气都从这里来 */
  MSG_PUSH: 7,
  /** 分组消息推送（另一个推送通道，多为系统消息） */
  MSG_PUSH_V2: 22
} as const

export interface HuyaMessage {
  uri: number
  body: Buffer
}

/**
 * WebSocketCommand { 0: iCmdType (INT), 1: vData (byte[]), 2: lRequestId, 3: traceId }
 * （字段号取自虎牙页面自带的 `WebSocketCommand.writeTo`，2026-09-17 核对）
 *
 * ⚠️ 这里**曾经完全解不出真实帧**（45 秒 477 帧命中 0），根因与修复：
 * 真实帧是 Tars/WUP 信封，形如 `00 03 1d 00 01 00 88 …`，其中 `0x1D` 的低半字节
 * 是**类型 13 = EN_SIMPLELIST**。JCE 类型表只到 12；Tars 用它编码 `byte[]`，
 * 而 `vData` / `sMsg` 都是 `byte[]` → 读取器遇到未知类型即中断，什么都取不到。
 * 修复：`jce.ts` 补上 SIMPLE_LIST(13) 与 MAP(8)（详见那里的注释）。
 *
 * 类型表与整数编码规则均**读自虎牙页面自带的 `JceOutputStream`/`JceInputStream`**，
 * 不是推测（2026-09-17）。真实帧夹具见 `tests/fixtures/huya-frames.json`。
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
