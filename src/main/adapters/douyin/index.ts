import type { CaptureSource, DanmakuMessage } from '../../../shared/types'
import { DOUYIN_HOOK_SCRIPT } from '../../webview/inject/douyinHook'
import { buildDouyinSendScript } from '../../webview/inject/douyinSender'
import type { FrameResult, PlatformAdapter } from '..'
import { parseNumericRoomId } from '../roomId'
import { parsePushFrame } from './frame'
import { mapDouyinMessage } from './mapper'

export const douyinAdapter: PlatformAdapter = {
  platform: 'douyin',

  roomUrl: (roomId) => `https://live.douyin.com/${roomId}`,

  parseRoomId: parseNumericRoomId,

  injectScript: () => DOUYIN_HOOK_SCRIPT,

  /** 抖音 DOM 结构随构建版本变动大，选择器需真实环境确认，暂不提供兜底 */
  domFallbackScript: () => null,

  isDanmakuWs: (url) => /webcast/i.test(url) && /im/i.test(url),

  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult {
    const danmaku: DanmakuMessage[] = []
    for (const message of parsePushFrame(raw)) {
      const mapped = mapDouyinMessage(message.method, message.payload, roomId, source)
      if (mapped) danmaku.push(mapped)
    }
    return { danmaku }
  },

  sendScript: buildDouyinSendScript
}
