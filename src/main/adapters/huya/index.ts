import { session } from 'electron'
import type { CaptureSource, DanmakuMessage } from '../../../shared/types'
import { DOM_OBSERVER_SCRIPT } from '../../webview/inject/domObserver'
import { buildHuyaSendScript } from '../../webview/inject/huyaSender'
import type { FrameResult, PlatformAdapter } from '..'
import { parseHuyaRoomId } from '../roomId'
import { parseHuyaFrame } from './frame'
import { mapHuyaMessage } from './mapper'

export const huyaAdapter: PlatformAdapter = {
  platform: 'huya',

  roomUrl: (roomId) => `https://www.huya.com/${roomId}`,

  parseRoomId: parseHuyaRoomId,

  /**
   * **不注入任何脚本**（2026-09-18 决策）。
   *
   * 理由（不是「hook 会导致跳转」—— 那个假设已被实验推翻，移除 hook 后页面照样被跳）：
   * 1. WS 侧的 uri=1400 弹幕只有 1~5 条/75 秒，价值远低于侵入页面的风险；
   * 2. 弹幕主通道是页面已渲染的聊天列表 → DOM 兜底（不碰页面、不被检测）；
   * 3. 虎牙对页面主世界改写敏感度未知，少动一处少一分风险。
   *
   * WUP/JCE 信封解析器（frame.ts / jce.ts）与 huyaHook 脚本作为协议层资产保留，随时可复用。
   */
  injectScript: () => '',

  /**
   * DOM 兜底：观察页面已渲染的聊天列表（#chat-room__list），
   * 条目 innerText 为「昵称 : 内容」格式，由通用 DOM 观察器解析。
   * 这是虎牙当前**主抓取通道**。
   */
  domFallbackScript: () => DOM_OBSERVER_SCRIPT,

  /**
   * ⚠️ 拦截「房间页 → 错误页」的前端跳转（2026-09-18 实测有效手段）。
   *
   * 虎牙会在房间页加载完成后用 JS 把页面跳到 error?errorType=ROOM_NOT_FOUND
   * （服务端实际返回了正常房间页）。在 will-navigate 层拦下后页面停在原位，
   * 聊天列表照常渲染，DOM 兜底即可抓取。
   */
  isBlockedNavigation: (url) => /huya\.com\/error/i.test(url),

  /**
   * ⚠️ 必须「清 Cookie → 访首页 → 进房间」三步走（2026-09-18 完整实验链结论）：
   * 1. 残留 Cookie 会让服务端把房间页 302 到错误页 → 进房前 resetSession 清掉；
   * 2. 清完后首次进房没有游客身份，弹幕区不初始化（聊天列表只有系统消息）→
   *    先访一次首页让服务端下发游客 Cookie，再进房间弹幕组件即正常挂载。
   */
  warmupUrl: () => 'https://www.huya.com/',

  /** 清掉残留 Cookie：实测是房间页被 302 到错误页的直接原因（见接口注释） */
  resetSession: async () => {
    await session.defaultSession.clearStorageData({
      origin: 'https://www.huya.com',
      storages: ['cookies']
    })
  },

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
