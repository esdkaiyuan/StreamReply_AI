import type { DanmakuMessage, TriggerMode } from '../../shared/types'

const QUESTION_RE = /[？?]|吗|呢/

/** 规格第 7 节触发规则；礼物在任何模式都触发感谢 */
export function shouldReply(msg: DanmakuMessage, mode: TriggerMode, keywords: string[]): boolean {
  if (msg.type === 'gift') return true
  if (msg.type !== 'chat') return false
  switch (mode) {
    case 'all':
      return true
    case 'question':
      return QUESTION_RE.test(msg.content)
    case 'keyword':
      return keywords.some((k) => k.trim() && msg.content.includes(k.trim()))
    case 'smart':
    default:
      return true // AI 自行决定 ignore
  }
}
