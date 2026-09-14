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

  /** 虎牙弹幕列表 DOM 结构随版本变动，选择器需真实环境确认，暂不提供兜底 */
  domFallbackScript: () => null,

  isDanmakuWs: (url) => /huya/i.test(url),

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
