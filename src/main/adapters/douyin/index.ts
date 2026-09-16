import type { CaptureSource, DanmakuMessage } from '../../../shared/types'
import { followRedirect } from '../../net/resolveShareLink'
import { DOUYIN_HOOK_SCRIPT } from '../../webview/inject/douyinHook'
import { buildDouyinSendScript } from '../../webview/inject/douyinSender'
import type { FrameResult, PlatformAdapter } from '..'
import { parseNumericRoomId } from '../roomId'
import { parsePushFrame } from './frame'
import { mapDouyinMessage, readDouyinOnlineCount } from './mapper'

export const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',

  roomUrl: (roomId) => `https://live.douyin.com/${roomId}`,

  parseRoomId: parseNumericRoomId,

  /**
   * 分享短链归一化：`v.douyin.com/xxx` 这类链接里**没有房间号**，
   * 必须跳转一次才能拿到 `live.douyin.com/<web_rid>`。离线解析只能是猜，所以真发一次请求。
   */
  normalizeInput: async (input) => {
    if (!/v\.douyin\.com|iesdouyin\.com|douyin\.com\/share/i.test(input)) return input
    return followRedirect(input)
  },

  injectScript: () => DOUYIN_HOOK_SCRIPT,

  /**
   * 抓取走 CDP 网络事件，而不是页面 hook。
   *
   * 原因：抖音的签名（`signature`/`a_bogus`）由页面自己的 webmssdk 生成，
   * 抓取只能「旁路观察」；而它可能把连接建在 Worker / 内部实现里 ——
   * 主世界 patch 看不到。CDP 事件是浏览器进程级的，Worker 内也一样能拿到，
   * 并且能直接拿到端点 URL 用于过滤。开启后不再注入页面 hook，避免双源重复。
   */
  captureViaCdp: true,

  /**
   * HTTP 推流端点判定（**仅用于诊断上报**）。
   * 公开实现显示抖音也可能走 `webcast/im/fetch` 的流式响应而非 WebSocket；
   * 命中会打印分片日志，便于确认真实环境到底走哪条通道后再决定是否做流式重组。
   */
  isDanmakuStream: (url) => /webcast/i.test(url) && /\/im\//i.test(url),

  /** DOM 结构随构建版本变动大，选择器需真实环境确认，暂不提供兜底 */
  domFallbackScript: () => null,

  isDanmakuWs: (url) => /webcast/i.test(url) && /(im|push)/i.test(url),

  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult {
    const danmaku: DanmakuMessage[] = []
    let onlineCount: number | undefined
    // 在线人数与弹幕共用同一条 IM 通道，解析一次帧就能顺路取出，不必额外请求
    for (const message of parsePushFrame(raw)) {
      const total = readDouyinOnlineCount(message.method, message.payload)
      if (total !== undefined) {
        onlineCount = total
        continue
      }
      const mapped = mapDouyinMessage(message.method, message.payload, roomId, source)
      if (mapped) danmaku.push(mapped)
    }
    return { danmaku, onlineCount }
  },

  sendScript: buildDouyinSendScript
}
