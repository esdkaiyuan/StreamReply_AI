import type { CaptureSource } from '../../../shared/types'
import { KS_HOOK_SCRIPT } from '../../webview/inject/ksHook'
import { buildKuaishouSendScript } from '../../webview/inject/ksSender'
import type { FrameResult, PlatformAdapter } from '..'
import { parseKuaishouRoomId } from '../roomId'
import { KS_PAYLOAD, parseSocketMessage } from './frame'
import { mapKuaishouFeedPush } from './mapper'

export const kuaishouAdapter: PlatformAdapter = {
  platform: 'kuaishou',

  roomUrl: (roomId) => `https://live.kuaishou.com/u/${roomId}`,

  injectScript: () => KS_HOOK_SCRIPT,

  /** 快手 DOM 结构随构建版本变动大，选择器需真实环境确认，暂不提供兜底 */
  domFallbackScript: () => null,

  isDanmakuWs: (url) => /kuaishou|kwai|live-ws/i.test(url),

  parseRoomId: parseKuaishouRoomId,

  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult {
    const message = parseSocketMessage(raw)
    if (!message || message.payloadType !== KS_PAYLOAD.SC_FEED_PUSH) return { danmaku: [] }
    return mapKuaishouFeedPush(message.payload, roomId, source)
  },

  sendScript: buildKuaishouSendScript
}
