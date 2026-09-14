import type { CaptureSource, DanmakuMessage, RoomStatEvent } from '../../../shared/types'
import { DOM_OBSERVER_SCRIPT } from '../../webview/inject/domObserver'
import { buildSendScript } from '../../webview/inject/sender'
import { WS_HOOK_SCRIPT } from '../../webview/inject/wsHook'
import type { FrameResult, PlatformAdapter } from '..'
import { parseNumericRoomId } from '../roomId'
import { mapBilibiliEvent } from './mapper'
import { OP, decodeBody, splitPackets } from './protocol'

export const bilibiliAdapter: PlatformAdapter = {
  platform: 'bilibili',

  roomUrl: (roomId) => `https://live.bilibili.com/${roomId}`,

  parseRoomId: parseNumericRoomId,

  injectScript: () => WS_HOOK_SCRIPT,

  domFallbackScript: () => DOM_OBSERVER_SCRIPT,

  /**
   * WS 端点判定。
   * 实测：当前网页端弹幕主机是 `*.chat.bilibili.com`，历史/长连接为 `broadcastlv`。
   */
  isDanmakuWs: (url) => /broadcastlv|chat\.bilibili\.com/i.test(url),

  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult {
    const danmaku: DanmakuMessage[] = []
    let onlineCount: number | undefined

    const handleEvent = (event: unknown): void => {
      const cmd = String((event as Record<string, unknown> | null)?.['cmd'] ?? '')
      if (!cmd) return
      const mapped = mapBilibiliEvent(cmd, event, roomId, source)
      if (!mapped) return
      if ('type' in mapped) danmaku.push(mapped as DanmakuMessage)
      else onlineCount = (mapped as RoomStatEvent).onlineCount ?? onlineCount
    }

    // 形态一：二进制协议帧（16 字节头 + 可选的 brotli 压缩子帧）
    for (const packet of splitPackets(raw)) {
      if (packet.op !== OP.MESSAGE) continue // 认证/心跳由页面自身处理
      for (const body of decodeBody(packet)) {
        try {
          handleEvent(JSON.parse(body.toString('utf8')))
        } catch {
          /* 坏体跳过 */
        }
      }
    }

    // 形态二：纯 JSON 文本帧（网页端部分通道直接推 JSON，无二进制头）
    // 二进制协议的包长字段在首字节，不可能是 '{'，所以这个嗅探不会误判
    if (danmaku.length === 0 && onlineCount === undefined && raw.length > 0 && raw[0] === 0x7b) {
      try {
        handleEvent(JSON.parse(raw.toString('utf8')))
      } catch {
        /* 非 JSON，忽略 */
      }
    }

    return onlineCount === undefined ? { danmaku } : { danmaku, onlineCount }
  },

  sendScript: buildSendScript
}
