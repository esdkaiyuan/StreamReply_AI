import type { ReplyTask } from '../../shared/types'
import { resolveGapMs } from './gap'

export type SendTask = ReplyTask

export interface SchedulerOptions {
  minDelayMs: number
  maxDelayMs: number
  maxPerMinute: number
  maxPerHour: number
  requireConfirm: boolean
  sender: (task: SendTask) => Promise<boolean>
  onEvent?: (tasks: SendTask[]) => void
}

const CIRCUIT_FAILURES = 3
const CIRCUIT_MS = 5 * 60 * 1000
const TICK_MS = 500
const MAX_HISTORY = 50

/**
 * 规格第 6 节防风控调度：优先级队列 + 随机延迟 + 频率硬上限 + 熔断 + 可选人工确认。
 */
export class SendScheduler {
  private queue: SendTask[] = []
  private history: SendTask[] = []
  private sentTimes: number[] = []
  private failures = 0
  private circuitUntil = 0
  private nextSendAt = Date.now()
  private timer: NodeJS.Timeout | null = null

  constructor(private opts: SchedulerOptions) {}

  enqueue(task: SendTask): void {
    if (this.opts.requireConfirm) {
      this.history.unshift({ ...task, status: 'pending-confirm' })
      this.emit()
      return
    }
    this.pushQueue({ ...task, status: 'queued' })
  }

  /** 人工确认发送 */
  confirm(id: string): void {
    const idx = this.history.findIndex((t) => t.id === id && t.status === 'pending-confirm')
    if (idx < 0) return
    const [t] = this.history.splice(idx, 1)
    this.pushQueue({ ...t, status: 'queued' })
  }

  /** 人工弃用 */
  reject(id: string): void {
    const t = this.history.find((x) => x.id === id && x.status === 'pending-confirm')
    if (!t) return
    t.status = 'rejected'
    this.emit()
  }

  /** 人工确认前修改回复文本 */
  edit(id: string, text: string): void {
    const t = this.history.find((x) => x.id === id && x.status === 'pending-confirm')
    if (!t) return
    t.text = text
    this.emit()
  }

  retry(id: string): void {
    const t = this.history.find((x) => x.id === id && x.status === 'failed')
    if (!t) return
    this.pushQueue({ ...t, status: 'queued' })
  }

  pendingConfirm(): SendTask[] {
    return this.history.filter((t) => t.status === 'pending-confirm')
  }

  snapshot(): {
    queue: SendTask[]
    history: SendTask[]
    sentLastMinute: number
    sentLastHour: number
  } {
    const now = Date.now()
    return {
      queue: [...this.queue],
      history: [...this.history],
      sentLastMinute: this.sentTimes.filter((t) => now - t < 60_000).length,
      sentLastHour: this.sentTimes.filter((t) => now - t < 3_600_000).length
    }
  }

  isCircuitOpen(): boolean {
    return Date.now() < this.circuitUntil
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private pushQueue(task: SendTask): void {
    if (task.priority === 'high') {
      const firstNormal = this.queue.findIndex((t) => t.priority !== 'high')
      if (firstNormal < 0) this.queue.push(task)
      else this.queue.splice(firstNormal, 0, task)
    } else {
      this.queue.push(task)
    }
    this.emit()
    this.start()
  }

  private start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    if (this.queue.length === 0) {
      this.stop()
      return
    }
    if (now < this.circuitUntil || now < this.nextSendAt) return
    const minute = this.sentTimes.filter((t) => now - t < 60_000).length
    const hour = this.sentTimes.filter((t) => now - t < 3_600_000).length
    if (minute >= this.opts.maxPerMinute || hour >= this.opts.maxPerHour) return

    const task = this.queue.shift()!
    // 下一次发送至少间隔 [minDelayMs, maxDelayMs]（闭区间随机取值；
    // 用统一 helper 保证「上界取得到」且配置写反时不会失控）
    this.nextSendAt = now + resolveGapMs(this.opts.minDelayMs, this.opts.maxDelayMs)

    task.status = 'sending'
    this.emit()
    let ok = false
    try {
      ok = await this.opts.sender(task)
    } catch {
      ok = false
    }
    task.sentAt = Date.now()
    task.status = ok ? 'sent' : 'failed'
    if (ok) {
      this.failures = 0
      this.sentTimes.push(task.sentAt)
    } else {
      this.failures += 1
      if (this.failures >= CIRCUIT_FAILURES) this.circuitUntil = Date.now() + CIRCUIT_MS
    }
    this.history.unshift(task)
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY
    this.emit()
  }

  private emit(): void {
    const snap = this.snapshot()
    this.opts.onEvent?.(snap.queue.concat(snap.history))
  }
}
