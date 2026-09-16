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
 *
 * ⚠️ **已知缺陷（2026-09-17 实测，尚未修复）**：
 * 真实直播间的帧并不是「裸 Tars 结构」，而是 **WUP/TAF 信封**：
 * 形如 `00 <cmdType> 1d ...`，其中 `0x1D` 的**低半字节是类型 13 —— 标准 JCE/Tars
 * 类型表里没有 13**（只有 0~12），本读取器遇到未知类型会中断，因此对真实帧解出 0 条消息。
 *
 * 证据（真实帧已存为测试夹具 `tests/fixtures/huya-frames.json`，取自 live.huya.com/lpl）：
 * - 45 秒抓到 477 帧，`parseHuyaFrame` 命中 0；
 * - 帧内可见 WUP 结构特征字符串：`launch`(servant) / `wsLaunch`(func) / `tReq` / `tRsp` / `HUYA&ZH&2052`；
 * - 客户端注册帧为 `00 03 1d 00 01 00 88 00 00 00 88 10 03 2c 3c 40 ff 56 06 launch 66 08 wsLaunch …`，
 *   其中 `40 ff` = tag4 BYTE(-1) 恰是 `setRequestId(-1)`，与公开实现一致。
 *
 * 离线试解结论：把「类型 13」当作 STRUCT_BEGIN 后能解出上述字符串，
 * 但完整消费整帧仍会在信封内部的 MAP/长度字段处失配 ——
 * 需要拿到虎牙页面自带的 Wup 编解码实现（或 WUP 规范）来确定信封的准确布局后再改。
 * 在修好之前，**本平台抓取不工作**，UI 会如实显示失败而不是假装已连上。
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
