import { resolveGapMs } from '../sender/gap'

export interface RandomReplyTimerOptions {
  getMinMs(): number
  getMaxMs(): number
  /** 每次到时触发；抛异常不会让定时器停摆 */
  onFire(): void
  rand?: () => number
  /** 便于测试注入假定时器 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * 「随机自动回复」的节奏器：每隔一个随机时长（`[min,max]`）回调一次。
 *
 * 为什么单独抽出来：随机模式与「弹幕到达」无关，需要自己的节拍、
 * 自己的启停，以及设置改动后的即时重排；混在管线里既难测也容易泄漏定时器。
 * 每次都重新取随机值，所以触发间隔不会形成可被识别的固定周期。
 */
export class RandomReplyTimer {
  private handle: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(private opts: RandomReplyTimerOptions) {}

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.arm()
  }

  stop(): void {
    this.running = false
    this.disarm()
  }

  /** 设置改动后调用：取消已排的那次，按新间隔重排（未启动时什么也不做） */
  reschedule(): void {
    if (!this.running) return
    this.disarm()
    this.arm()
  }

  private disarm(): void {
    if (this.handle === null) return
    const clear = this.opts.clearTimer ?? clearTimeout
    clear(this.handle)
    this.handle = null
  }

  private arm(): void {
    const ms = resolveGapMs(this.opts.getMinMs(), this.opts.getMaxMs(), this.opts.rand)
    const set = this.opts.setTimer ?? setTimeout
    this.handle = set(() => {
      this.handle = null
      try {
        this.opts.onFire()
      } catch {
        /* 单次失败不影响后续节奏 */
      } finally {
        if (this.running) this.arm()
      }
    }, ms)
  }
}
