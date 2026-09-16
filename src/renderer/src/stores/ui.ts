import { defineStore } from 'pinia'

/**
 * UI 全局状态。
 * 目前只做一件事：统计当前打开的模态层数量。
 *
 * 为什么需要：直播画面是**原生 WebContentsView**，永远绘制在网页内容之上，
 * 会盖住设置抽屉/登录弹窗。所以弹窗打开时必须把画面移回屏外。
 */
export const useUiStore = defineStore('ui', {
  state: () => ({ modals: 0 }),
  getters: {
    modalOpen: (s) => s.modals > 0
  },
  actions: {
    openModal(): void {
      this.modals += 1
    },
    closeModal(): void {
      this.modals = Math.max(0, this.modals - 1)
    }
  }
})
