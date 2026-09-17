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

  /**
   * ⚠️ **游客态实测结论（2026-09-17，真实直播间 CDP 侦察）**：
   *
   * - 快手网页版游客（无 Cookie + 触发风控验证码）**不建立弹幕 WebSocket**：
   *   页面会请求 `live_api/liveroom/websocketinfo`（鉴权入口），
   *   但游客拿不到有效连接信息 → 页面弹幕区只渲染**历史弹幕快照**，不更新；
   * - 已排除：主世界 WS（hook=0）、全部 CDP session 的 WS/HTTP 轮询/SSE（0）——
   *   数据不是「换了个通道」，而是**根本没拉实时数据**；
   * - 因此本平台的抓取在**登录后**才能收口（协议层 SocketMessage/SC_FEED_PUSH 已就绪，
   *   WS 一旦建立，页面注入 hook 即可抓到）；风控对高频访问限流狠（「请求过快」），
   *   自动化验证需长间隔。
   */
  /** 快手 DOM 结构随构建版本变动大，选择器需真实环境确认，暂不提供兜底 */
  domFallbackScript: () => null,

  isDanmakuWs: (url) => /kuaishou|kwai|gifshow|live-ws/i.test(url),

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
