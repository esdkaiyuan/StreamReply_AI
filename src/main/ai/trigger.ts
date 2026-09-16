import type { DanmakuMessage, TriggerMode } from '../../shared/types'

const QUESTION_RE = /[？?]|吗|呢/

/**
 * 规格第 7 节触发规则；礼物在任何「到达驱动」的模式下都触发感谢。
 *
 * ⚠️ `random` 模式**不在这里判断**：它不看内容、也不逐条触发，
 * 而是由 `RandomReplyTimer` 按随机间隔主动从最近的弹幕池里挑一条回复
 * （见 pipeline.ts）。所以这里对 `random` 一律返回 false，避免「到一条回一条」。
 */
export function shouldReply(msg: DanmakuMessage, mode: TriggerMode, keywords: string[]): boolean {
  if (mode === 'random') return false
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

/**
 * 从最近的弹幕池里随机挑一条作为回复对象。
 *
 * 排除：已回复过的（按 id 去重）、以及没有可回复内容的类型（进场/点赞等）。
 * `avoidNickname` 用于尽量不连着回同一个人 —— 只有在存在其他候选人时才生效，
 * 否则宁可继续回复同一个人，也不返回 null（否则随机模式会「静默不动」）。
 */
export function pickRandomDanmaku(
  pool: DanmakuMessage[],
  repliedIds: ReadonlySet<string>,
  rand: () => number = Math.random,
  avoidNickname?: string
): DanmakuMessage | null {
  const candidates = pool.filter(
    (m) => (m.type === 'chat' || m.type === 'gift') && !repliedIds.has(m.id)
  )
  if (candidates.length === 0) return null

  let list = candidates
  if (avoidNickname) {
    const others = candidates.filter((m) => m.user.nickname !== avoidNickname)
    if (others.length > 0) list = others
  }

  const r = rand()
  const ratio = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0
  const index = Math.min(list.length - 1, Math.floor(ratio * list.length))
  return list[index] ?? null
}
