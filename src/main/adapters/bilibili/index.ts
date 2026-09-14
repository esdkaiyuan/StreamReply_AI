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

  isDanmakuWs: (url) => /broadcastlv/i.test(url),

  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult {
    const danmaku: DanmakuMessage[] = []
    let onlineCount: number | undefined

    for (const packet of splitPackets(raw)) {
      if (packet.op !== OP.MESSAGE) continue // 认证/心跳由页面自身处理
      for (const body of decodeBody(packet)) {
        let event: Record<string, unknown>
        try {
          event = JSON.parse(body.toString('utf8'))
        } catch {
          continue
        }
        const cmd = String(event['cmd'] ?? '')
        const mapped = mapBilibiliEvent(cmd, event, roomId, source)
        if (!mapped) continue
        if ('type' in mapped) danmaku.push(mapped as DanmakuMessage)
        else onlineCount = (mapped as RoomStatEvent).onlineCount ?? onlineCount
      }
    }
    return onlineCount === undefined ? { danmaku } : { danmaku, onlineCount }
  },

  sendScript: buildSendScript
}
