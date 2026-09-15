/**
 * Cookie 串解析（纯函数，便于单测）。
 *
 * 需要容错三种常见粘贴形态：
 * 1. `SESSDATA=x; bili_jct=y`（浏览器 Application 面板复制的值）
 * 2. `document.cookie` 原文（可能含换行）
 * 3. 带多余属性 `SESSDATA=x; Path=/; Domain=.bilibili.com`
 */

export interface CookiePair {
  name: string
  value: string
}

/** Cookie 属性名（不是真正的 Cookie；粘贴含 `Path=/` 的串时必须剔除） */
const ATTRIBUTE_NAMES = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'samesite',
  'secure',
  'httponly',
  'version',
  'comment'
])

/** 从一组 `Set-Cookie` 原文里取出 name=value（丢弃属性段） */
export function parseCookiePairs(inputs: string[]): CookiePair[] {
  const pairs: CookiePair[] = []
  for (const raw of inputs) {
    const first = String(raw ?? '').split(';')[0] ?? ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (!name || ATTRIBUTE_NAMES.has(name.toLowerCase())) continue
    pairs.push({ name, value })
  }
  return pairs
}

/** 解析用户粘贴的 Cookie 文本 */
export function parseCookieInput(input: string): CookiePair[] {
  const text = String(input ?? '')
    .replace(/[\r\n]+/g, '; ')
    .trim()
  if (!text) return []
  // 常见误粘贴：整段是 `Cookie: a=1; b=2`
  const withoutPrefix = text.replace(/^cookie\s*:\s*/i, '')
  const segments = withoutPrefix
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  return parseCookiePairs(segments)
}

/** 判断是否够用来登录：缺 SESSDATA 一定失败，提前拦住给明确提示 */
export function hasSessionCookie(pairs: CookiePair[]): boolean {
  return pairs.some((p) => p.name === 'SESSDATA' && p.value.length > 0)
}
