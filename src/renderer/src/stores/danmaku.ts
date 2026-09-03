import { defineStore } from 'pinia'
import type { DanmakuMessage } from '../../../shared/types'

const MAX_ITEMS = 200

export const useDanmakuStore = defineStore('danmaku', {
  state: () => ({ items: [] as DanmakuMessage[] }),
  actions: {
    push(m: DanmakuMessage) {
      this.items.push(m)
      if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS)
    },
    clear() { this.items = [] }
  }
})
