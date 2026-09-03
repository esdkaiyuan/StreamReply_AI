/** 从用户输入解析 B 站房间号：纯数字任意长度直取；URL 取路径数字段（先于查询参数）；兜底取 4 位以上数字串 */
export function parseRoomId(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  if (/^\d+$/.test(t)) return t
  const seg = t.match(/\/(\d+)(?=[/?#]|$)/)
  if (seg) return seg[1]
  const loose = t.match(/(\d{4,})/)
  return loose ? loose[1] : null
}
