import { defineStore } from 'pinia'
import type { Platform, RoomInfo } from '../../../shared/types'

export const useRoomStore = defineStore('rooms', {
  state: () => ({
    rooms: [] as RoomInfo[],
    /** 各房间累计实收弹幕条数（来自主进程周期推送），用于自查抓取是否在工作 */
    counts: {} as Record<string, number>
  }),
  actions: {
    async refresh() {
      this.rooms = await window.lda.listRooms()
    },
    setCount(roomId: string, n: number) {
      this.counts = { ...this.counts, [roomId]: n }
    },
    async add(input: string, platform?: Platform) {
      const res = await window.lda.addRoom(input, platform)
      await this.refresh()
      return res
    },
    async remove(roomId: string) {
      await window.lda.removeRoom(roomId)
      await this.refresh()
    },
    applyStatus(r: RoomInfo) {
      const i = this.rooms.findIndex((x) => x.roomId === r.roomId)
      if (i >= 0) this.rooms[i] = r
      else this.rooms.push(r)
    }
  }
})
