import { defineStore } from 'pinia'
import type { RoomInfo, RoomStatEvent } from '../../../shared/types'

export const useRoomStore = defineStore('rooms', {
  state: () => ({
    rooms: [] as RoomInfo[],
    rates: {} as Record<string, number>,
    online: {} as Record<string, number | undefined>
  }),
  actions: {
    async refresh() { this.rooms = await window.lda.listRooms() },
    async add(input: string) {
      const res = await window.lda.addRoom(input)
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
    },
    applyStat(s: RoomStatEvent) {
      this.rates[s.roomId] = s.danmakuRate
      this.online[s.roomId] = s.onlineCount
    }
  }
})
