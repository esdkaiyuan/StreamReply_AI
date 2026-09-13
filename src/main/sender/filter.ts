const DEDUP_WINDOW_MS = 10 * 60 * 1000
const MAX_TRACKED = 500

/** 规格第 6 节：敏感词过滤 + 同内容 10 分钟去重 */
export class ReplyFilter {
  private lastSeen = new Map<string, number>()

  constructor(private sensitiveWords: string[]) {}

  /** 设置抽屉改词后即时生效，不丢失已积累的去重记录 */
  setSensitiveWords(words: string[]): void {
    this.sensitiveWords = words
  }

  /** 通过时即占位登记，避免同一文本在窗口内被重复放行 */
  passesText(text: string, now = Date.now()): boolean {
    if (this.sensitiveWords.some((w) => w.trim() && text.includes(w.trim()))) return false
    const last = this.lastSeen.get(text)
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return false
    this.markSent(text, now)
    return true
  }

  markSent(text: string, now = Date.now()): void {
    this.lastSeen.set(text, now)
    if (this.lastSeen.size > MAX_TRACKED) this.evictExpired(now)
  }

  private evictExpired(now: number): void {
    for (const [k, t] of this.lastSeen) {
      if (now - t > DEDUP_WINDOW_MS) this.lastSeen.delete(k)
    }
  }
}
