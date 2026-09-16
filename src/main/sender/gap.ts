/**
 * 回复节奏（间隔）计算。
 *
 * 抽成纯函数是为了可单测：随机区间最容易出的错是
 * 「上界永远取不到」（`min + floor(rand*(max-min))`）与「配置写反导致负区间」。
 */

/**
 * 返回 `[minMs, maxMs]` **闭区间**内的一个随机毫秒数。
 *
 * - `min > max` → 取 `min`（不返回区间外的值）
 * - 非有限值（NaN/负数）→ 按 0 处理
 * - `rand` 返回非有限值 → 按 0 处理
 */
export function resolveGapMs(minMs: number, maxMs: number, rand: () => number = Math.random): number {
  const safe = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
  const lo = safe(minMs)
  let hi = safe(maxMs)
  if (hi < lo) hi = lo
  if (hi === lo) return lo

  const r = rand()
  const ratio = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0
  return lo + Math.min(hi - lo, Math.floor(ratio * (hi - lo + 1)))
}

/**
 * 从「秒」为单位的设置项求间隔毫秒。
 * 保证至少 1 秒，且 `max ≥ min`（用户在输入框里写反了也不会失控）。
 */
export function gapMsFromSec(minSec: number, maxSec: number, rand: () => number = Math.random): number {
  const lo = Math.max(1, Number.isFinite(minSec) ? Math.floor(minSec) : 1)
  const hi = Math.max(lo, Number.isFinite(maxSec) ? Math.floor(maxSec) : lo)
  return resolveGapMs(lo * 1000, hi * 1000, rand)
}
