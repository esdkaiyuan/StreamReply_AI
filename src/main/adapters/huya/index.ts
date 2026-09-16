import type { CaptureSource, DanmakuMessage } from '../../../shared/types'
import { HUYA_HOOK_SCRIPT } from '../../webview/inject/huyaHook'
import { buildHuyaSendScript } from '../../webview/inject/huyaSender'
import type { FrameResult, PlatformAdapter } from '..'
import { parseHuyaRoomId } from '../roomId'
import { parseHuyaFrame } from './frame'
import { mapHuyaMessage } from './mapper'

export const huyaAdapter: PlatformAdapter = {
  platform: 'huya',

  roomUrl: (roomId) => `https://www.huya.com/${roomId}`,

  parseRoomId: parseHuyaRoomId,

  injectScript: () => HUYA_HOOK_SCRIPT,

  /**
   * 抓取走 CDP 网络事件。
   *
   * 依据 2026-09-17 实测：虎牙页面的弹幕连接是
   * `wss://wsapi.huya.com/?baseinfo=...`（也见 `*-ws.va.huya.com`），
   * 45 秒内抓到 477 帧。CDP 是浏览器进程级事件，不受「连接建在哪」影响，
   * 也免去对页面 hook 的依赖。
   */
  captureViaCdp: true,

  /** 虎牙弹幕列表 DOM 结构随版本变动，选择器需真实环境确认，暂不提供兜底 */
  domFallbackScript: () => null,

  /**
   * 虎牙 WS 端点判定。
   * 实测弹幕连接在 `wsapi.huya.com` 与 `*-ws.va.huya.com`；
   * 历史实现里还有 `cdnws.api.huya.com`。**不要用宽泛的 `/huya/i`** —— 那会把
   * 页面自身的其它请求也算进来。
   *
   * 注意：即使这里判错，CDP 通道仍会把帧上送、由 `parseFrame` 做内容校验，
   * 所以此正则只影响过滤效率，不影响能否抓到。
   */
  isDanmakuWs: (url) => /wsapi\.huya\.com|cdnws\.api\.huya\.com|-ws\.va\.huya\.com/i.test(url),

  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult {
    const danmaku: DanmakuMessage[] = []
    let onlineCount: number | undefined
    for (const item of parseHuyaFrame(raw)) {
      const mapped = mapHuyaMessage(item.uri, item.body, roomId, source)
      if (!mapped) continue
      if (mapped.kind === 'danmaku') danmaku.push(mapped.message)
      else onlineCount = mapped.count
    }
    return onlineCount === undefined ? { danmaku } : { danmaku, onlineCount }
  },

  sendScript: buildHuyaSendScript
}
