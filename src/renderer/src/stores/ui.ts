import { defineStore } from 'pinia'

/**
 * UI 全局状态。
 * 目前只做一件事：统计当前打开的模态层数量。
 *
 * 为什么需要：直播画面是**原生 WebContentsView**，永远绘制在网页内容之上，
 * 会盖住设置抽屉/登录弹窗。所以弹窗打开时必须把画面移回屏外。
 */
export const useUiStore = defineStore('ui', {
  state: () => ({
    modals: 0,
    /** 账号面板当前查看的平台（顶栏左上切换器控制） */
    activePlatform: (localStorage.getItem('lda.activePlatform') ?? 'bilibili') as string
  }),
  getters: {
    modalOpen: (s) => s.modals > 0
  },
  actions: {
    setActivePlatform(p: string): void {
      this.activePlatform = p
      localStorage.setItem('lda.activePlatform', p)
    },
    openModal(): void {
      this.modals += 1
    },
    closeModal(): void {
      this.modals = Math.max(0, this.modals - 1)
    }
  }
})
