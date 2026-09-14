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
