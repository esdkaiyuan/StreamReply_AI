import type { CaptureSource } from '../../../shared/types'
import { followRedirect } from '../../net/resolveShareLink'
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

  /**
   * 分享短链归一化：`v.kuaishou.com/xxx` 里没有主播 ID，必须跳转一次拿到 `/u/<id>`。
   * 离线解析只能是猜，所以真发一次请求（失败则回退原值，由 parseRoomId 报「无法解析」）。
   */
  normalizeInput: async (input) => {
    if (!/v\.kuaishou\.com|kuaishou\.com\/short/i.test(input)) return input
    return followRedirect(input)
  },

  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult {
    const message = parseSocketMessage(raw)
    if (!message || message.payloadType !== KS_PAYLOAD.SC_FEED_PUSH) return { danmaku: [] }
    return mapKuaishouFeedPush(message.payload, roomId, source)
  },

  sendScript: buildKuaishouSendScript
}
