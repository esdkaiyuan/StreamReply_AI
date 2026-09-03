import { EventEmitter } from 'events'
import type { DanmakuMessage, RoomStatEvent } from '../../shared/types'

class DanmakuBus extends EventEmitter {
  private timestamps: number[] = []

  publish(msg: DanmakuMessage): void {
    this.timestamps.push(msg.ts)
    this.emit('danmaku', msg)
  }

  /** 近 60 秒弹幕条数（供 RoomStatEvent.danmakuRate） */
  rate60s(now = Date.now()): number {
    this.timestamps = this.timestamps.filter((t) => now - t <= 60_000)
    return this.timestamps.length
  }

  buildStat(platform: RoomStatEvent['platform'], roomId: string, onlineCount?: number): RoomStatEvent {
    return { platform, roomId, onlineCount, danmakuRate: this.rate60s(), ts: Date.now() }
  }
}

export const bus = new DanmakuBus()
