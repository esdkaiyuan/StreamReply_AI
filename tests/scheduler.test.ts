import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SendScheduler, type SendTask } from '../src/main/sender/scheduler'

let seq = 0
function task(partial: Partial<SendTask> = {}): SendTask {
  seq += 1
  return {
    id: `t${seq}`,
    roomId: '1',
    replyTo: 'u',
    text: 'hello',
    emotion: 'answer',
    priority: 'normal',
    status: 'queued',
    createdAt: Date.now(),
    ...partial
  }
}

describe('send scheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('随机延迟后按优先级发送', async () => {
    const sent: string[] = []
    const s = new SendScheduler({
      minDelayMs: 8000,
      maxDelayMs: 25000,
      maxPerMinute: 2,
      maxPerHour: 100,
      requireConfirm: false,
      sender: async (text) => {
        sent.push(text)
        return true
      }
    })
    s.enqueue(task({ text: 'a', priority: 'normal' }))
    s.enqueue(task({ text: 'b', priority: 'high' }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toEqual(['b', 'a'])
    expect(s.snapshot().sentLastMinute).toBe(2)
  })

  it('每分钟 2 条上限：第三条等到下一窗口', async () => {
    const sent: string[] = []
    const s = new SendScheduler({
      minDelayMs: 0,
      maxDelayMs: 0,
      maxPerMinute: 2,
      maxPerHour: 100,
      requireConfirm: false,
      sender: async (text) => {
        sent.push(text)
        return true
      }
    })
    s.enqueue(task({ text: 'a' }))
    s.enqueue(task({ text: 'b' }))
    s.enqueue(task({ text: 'c' }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sent.length).toBe(2)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(sent.length).toBe(3)
  })

  it('requireConfirm 时先进入 pending-confirm，确认后才发', async () => {
    const sent: string[] = []
    const s = new SendScheduler({
      minDelayMs: 0,
      maxDelayMs: 0,
      maxPerMinute: 10,
      maxPerHour: 100,
      requireConfirm: true,
      sender: async (text) => {
        sent.push(text)
        return true
      }
    })
    s.enqueue(task({ text: 'x' }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toEqual([])
    const pending = s.pendingConfirm()
    expect(pending).toHaveLength(1)
    s.confirm(pending[0].id)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sent).toEqual(['x'])
  })

  it('连续失败 3 次熔断 5 分钟', async () => {
    const sender = vi.fn(async () => false)
    const s = new SendScheduler({
      minDelayMs: 0,
      maxDelayMs: 0,
      maxPerMinute: 100,
      maxPerHour: 100,
      requireConfirm: false,
      sender
    })
    for (let i = 0; i < 3; i++) s.enqueue(task({ text: `t${i}` }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sender).toHaveBeenCalledTimes(3)
    expect(s.isCircuitOpen()).toBe(true)

    s.enqueue(task({ text: 't4' }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sender).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sender).toHaveBeenCalledTimes(4)
  })
})
