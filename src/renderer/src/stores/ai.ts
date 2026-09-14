import { defineStore } from 'pinia'
import type { AiLogEntry, AiState } from '../../../shared/types'

const MAX_LOGS = 120

export const useAiStore = defineStore('ai', {
  state: () => ({
    state: null as AiState | null,
    logs: [] as AiLogEntry[],
    bound: false
  }),
  actions: {
    /** 订阅只建立一次，避免热更新/重复挂载导致日志翻倍 */
    init(): void {
      if (this.bound) return
      this.bound = true
      window.lda.onAiState((s) => {
        this.state = s
      })
      window.lda.onAiLog((e) => {
        this.logs.unshift(e)
        if (this.logs.length > MAX_LOGS) this.logs.length = MAX_LOGS
      })
    },
    clear(): void {
      this.logs = []
    }
  }
})
