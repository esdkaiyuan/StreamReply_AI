/**
 * 房间号解析。各平台格式不同，按平台分别实现后由适配器暴露：
 * - B 站 / 抖音：纯数字（B 站短号 1-8 位、长号 15-16 位；抖音为 19 位长 ID）
 * - 快手：字母数字混合的 principalId（如 3x7abc...），位于 URL 的 /u/ 段
 */

/** 纯数字房间号：直取 → URL 路径数字段（先于查询参数）→ 兜底取 4 位以上数字串 */
export function parseNumericRoomId(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  if (/^\d+$/.test(t)) return t
  const seg = t.match(/\/(\d+)(?=[/?#]|$)/)
  if (seg) return seg[1]
  const loose = t.match(/(\d{4,})/)
  return loose ? loose[1] : null
}

const HUYA_ID = /^[A-Za-z0-9_-]{2,40}$/

/** 虎牙房间号：数字房间号或主播自定义号（如 kaerlol），取 huya.com/ 之后的第一段 */
export function parseHuyaRoomId(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  const seg = t.match(/huya\.com\/([A-Za-z0-9_-]+)/i)
  if (seg) return seg[1]
  return HUYA_ID.test(t) ? t : null
}

const KS_ID = /^[A-Za-z0-9_-]{4,64}$/

/** 快手房间号：URL 的 /u/ 或 /profile/ 段；或直接给的 alphanumeric ID */
export function parseKuaishouRoomId(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  const seg = t.match(/\/(?:u|profile)\/([A-Za-z0-9_-]+)/i)
  if (seg) return seg[1]
  // 分享短链（v.kuaishou.com/xxx）需跳转才能拿到真实 ID，离线无法解析，不猜
  if (KS_ID.test(t)) return t
  return null
}
