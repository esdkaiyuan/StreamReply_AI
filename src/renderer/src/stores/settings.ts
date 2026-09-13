import { defineStore } from 'pinia'
import type { AppSettings } from '../../../shared/types'

export const useSettingsStore = defineStore('settings', {
  state: () => ({ s: null as AppSettings | null }),
  actions: {
    async load(): Promise<void> {
      this.s = await window.lda.getSettings()
    },
    async save(patch: Partial<AppSettings>): Promise<void> {
      this.s = await window.lda.setSettings(patch)
    },
    async toggleAi(): Promise<void> {
      const enabled = await window.lda.toggleAi()
      if (this.s) this.s.aiEnabled = enabled
    }
  }
})
