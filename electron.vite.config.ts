import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  // 关闭自动清空：out/ 下历史 chunk 累积后，批量删除会被安全策略拦截导致构建中断
  main: { plugins: [externalizeDepsPlugin()], build: { emptyOutDir: false } },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          webview: resolve(__dirname, 'src/preload/webview.ts')
        }
      }
    }
  },
  renderer: { plugins: [vue()], build: { emptyOutDir: false } }
})
