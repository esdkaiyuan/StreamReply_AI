import { EventEmitter } from 'events'
import type { DanmakuMessage, RoomStatEvent } from '../../shared/types'

class DanmakuBus extends EventEmitter {
  private timestamps: number[] = []
  /** 各房间累计收到的弹幕条数（供 UI 自查抓取是否在工作） */
  private byRoom = new Map<string, number>()

  publish(msg: DanmakuMessage): void {
    this.timestamps.push(msg.ts)
    this.byRoom.set(msg.roomId, (this.byRoom.get(msg.roomId) ?? 0) + 1)
    this.emit('danmaku', msg)
  }

  /** 近 60 秒弹幕条数（供 RoomStatEvent.danmakuRate） */
  rate60s(now = Date.now()): number {
    this.timestamps = this.timestamps.filter((t) => now - t <= 60_000)
    return this.timestamps.length
  }

  countOf(roomId: string): number {
    return this.byRoom.get(roomId) ?? 0
  }

  buildStat(platform: RoomStatEvent['platform'], roomId: string, onlineCount?: number): RoomStatEvent {
    return {
      platform,
      roomId,
      onlineCount,
      danmakuRate: this.rate60s(),
      danmakuCount: this.countOf(roomId),
      ts: Date.now()
    }
  }
}

export const bus = new DanmakuBus()
