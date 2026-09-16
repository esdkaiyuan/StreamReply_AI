import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DanmakuMessage } from '../src/shared/types'
import { pickRandomDanmaku } from '../src/main/ai/trigger'
import { RandomReplyTimer } from '../src/main/ai/randomTimer'
import { resolveGapMs, gapMsFromSec } from '../src/main/sender/gap'

function dm(id: string, nickname: string, type: DanmakuMessage['type'] = 'chat'): DanmakuMessage {
  return {
    id,
    platform: 'bilibili',
    roomId: '1',
    type,
    user: { uid: `u-${id}`, nickname },
    content: `内容-${id}`,
    ts: Date.now(),
    source: 'ws'
  }
}

describe('回复间隔计算', () => {
  it('落在 [min,max] 闭区间内', () => {
    for (let i = 0; i <= 20; i++) {
      const ms = resolveGapMs(8000, 25000, () => i / 20)
      expect(ms).toBeGreaterThanOrEqual(8000)
      expect(ms).toBeLessThanOrEqual(25000)
    }
  })

  it('rand=0 取到最小值，rand≈1 取到最大值（闭区间，不会永远取不到上界）', () => {
    expect(resolveGapMs(1000, 3000, () => 0)).toBe(1000)
    expect(resolveGapMs(1000, 3000, () => 0.999999)).toBe(3000)
  })

  it('min 与 max 相等时返回该值', () => {
    expect(resolveGapMs(5000, 5000, () => 0.7)).toBe(5000)
  })

  it('min > max 时不返回区间外的值', () => {
    const ms = resolveGapMs(9000, 3000, () => 0.5)
    expect(ms).toBe(9000)
  })

  it('非法值不产生 NaN', () => {
    expect(resolveGapMs(NaN, NaN, () => 0.5)).toBe(0)
    expect(resolveGapMs(-5, -1, () => 0.5)).toBe(0)
    expect(resolveGapMs(1000, NaN, () => 0.5)).toBe(1000)
    expect(Number.isNaN(resolveGapMs(1000, 2000, () => NaN))).toBe(false)
  })

  it('gapMsFromSec：秒转毫秒并保证至少 1 秒、max ≥ min', () => {
    expect(gapMsFromSec(8, 25, () => 0)).toBe(8000)
    expect(gapMsFromSec(0, 0, () => 0)).toBe(1000)
    expect(gapMsFromSec(30, 5, () => 0)).toBe(30000)
  })
})

describe('随机挑选回复对象', () => {
  it('从候选中随机取一条', () => {
    const pool = [dm('a', '甲'), dm('b', '乙'), dm('c', '丙')]
    expect(pickRandomDanmaku(pool, new Set(), () => 0)?.id).toBe('a')
    expect(pickRandomDanmaku(pool, new Set(), () => 0.999999)?.id).toBe('c')
  })

  it('跳过已回复过的弹幕', () => {
    const pool = [dm('a', '甲'), dm('b', '乙')]
    expect(pickRandomDanmaku(pool, new Set(['a']), () => 0)?.id).toBe('b')
  })

  it('只挑 chat 与 gift，跳过进场/点赞等无内容消息', () => {
    const pool = [dm('a', '甲', 'enter'), dm('b', '乙', 'like'), dm('c', '丙', 'gift')]
    expect(pickRandomDanmaku(pool, new Set(), () => 0)?.id).toBe('c')
  })

  it('候选为空或全被排除时返回 null', () => {
    expect(pickRandomDanmaku([], new Set(), () => 0)).toBeNull()
    expect(pickRandomDanmaku([dm('a', '甲')], new Set(['a']), () => 0)).toBeNull()
    expect(pickRandomDanmaku([dm('a', '甲', 'enter')], new Set(), () => 0)).toBeNull()
  })

  it('尽量避开上一条刚回复过的人（有替代对象时）', () => {
    const pool = [dm('a', '甲'), dm('b', '乙'), dm('c', '甲')]
    // rand=0 本会命中 a（甲），但要求避开甲 → 落到唯一的乙
    expect(pickRandomDanmaku(pool, new Set(), () => 0, '甲')?.id).toBe('b')
  })

  it('只有同一个人可挑时不会返回 null', () => {
    const pool = [dm('a', '甲'), dm('b', '甲')]
    expect(pickRandomDanmaku(pool, new Set(), () => 0, '甲')?.id).toBe('a')
  })
})

describe('随机回复定时器', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('在 [min,max] 内触发，并在每次触发后自动排下一次', async () => {
    const fires: number[] = []
    const t = new RandomReplyTimer({
      getMinMs: () => 10_000,
      getMaxMs: () => 10_000,
      onFire: () => fires.push(Date.now()),
      rand: () => 0
    })
    t.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fires).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fires).toHaveLength(2)
    t.stop()
  })

  it('stop() 后不再触发', async () => {
    const onFire = vi.fn()
    const t = new RandomReplyTimer({
      getMinMs: () => 5_000,
      getMaxMs: () => 5_000,
      onFire,
      rand: () => 0
    })
    t.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onFire).toHaveBeenCalledTimes(1)
    t.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onFire).toHaveBeenCalledTimes(1)
  })

  it('重复 start() 不会叠加出多次触发', async () => {
    const onFire = vi.fn()
    const t = new RandomReplyTimer({
      getMinMs: () => 5_000,
      getMaxMs: () => 5_000,
      onFire,
      rand: () => 0
    })
    t.start()
    t.start()
    t.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onFire).toHaveBeenCalledTimes(1)
    t.stop()
  })

  it('reschedule() 取消旧计时并按新间隔重排（设置改动即时生效）', async () => {
    let min = 2_000
    const onFire = vi.fn()
    const t = new RandomReplyTimer({
      getMinMs: () => min,
      getMaxMs: () => min,
      onFire,
      rand: () => 0
    })
    t.start()
    await vi.advanceTimersByTimeAsync(1_000)

    // 间隔改成 60s 并重排：原来 2s 的那次必须被取消
    min = 60_000
    t.reschedule()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onFire).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(55_000)
    expect(onFire).toHaveBeenCalledTimes(1)
    t.stop()
  })

  it('onFire 抛异常不会让定时器停摆', async () => {
    let calls = 0
    const t = new RandomReplyTimer({
      getMinMs: () => 1_000,
      getMaxMs: () => 1_000,
      onFire: () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
      },
      rand: () => 0
    })
    t.start()
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(calls).toBe(2)
    t.stop()
  })

  it('未 start() 时 reschedule() 不会启动计时', async () => {
    const onFire = vi.fn()
    const t = new RandomReplyTimer({
      getMinMs: () => 1_000,
      getMaxMs: () => 1_000,
      onFire,
      rand: () => 0
    })
    t.reschedule()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onFire).not.toHaveBeenCalled()
    expect(t.isRunning).toBe(false)
  })
})
