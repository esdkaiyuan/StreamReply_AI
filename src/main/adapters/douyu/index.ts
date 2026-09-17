import type { CaptureSource, DanmakuMessage } from '../../../shared/types'
import { DOUYU_HOOK_SCRIPT } from '../../webview/inject/douyuHook'
import { buildDouyuSendScript } from '../../webview/inject/douyuSender'
import type { FrameResult, PlatformAdapter } from '..'
import { parseNumericRoomId } from '../roomId'
import { splitPackets } from './frame'
import { mapDouyuMessage } from './mapper'
import { parseStt } from './stt'

export const douyuAdapter: PlatformAdapter = {
  platform: 'douyu',

  roomUrl: (roomId) => `https://www.douyu.com/${roomId}`,

  parseRoomId: parseNumericRoomId,

  injectScript: () => DOUYU_HOOK_SCRIPT,

  /**
   * 抓取走 CDP 网络事件（2026-09-17 实测切换）。
   *
   * 原因：斗鱼页面在建连**之后**才到 dom-ready，页面注入 hook 装上时
   * `danmuproxy` 连接已存在，页面自己的登录/心跳都发过了 —— 晚到的 hook
   * 抓不到既有连接，看门狗 8 秒超时后直接放弃该房间。
   * CDP 是浏览器进程级的，连接建立前 attach（先 loadURL 再 attach 的既定顺序）
   * 即可从第一个帧开始抓，实测 70 秒产出 34 条弹幕。
   */
  captureViaCdp: true,

  /** 斗鱼弹幕列表 DOM 结构随版本变动，选择器需真实环境确认，暂不提供兜底 */
  domFallbackScript: () => null,

  isDanmakuWs: (url) => /douyu|danmuproxy/i.test(url),

  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult {
    const danmaku: DanmakuMessage[] = []
    for (const body of splitPackets(raw)) {
      const mapped = mapDouyuMessage(parseStt(body), roomId, source)
      if (mapped) danmaku.push(mapped)
    }
    return { danmaku }
  },

  sendScript: buildDouyuSendScript
}
