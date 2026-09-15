import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerRoomIpc, rebindRoomWindow } from './rooms/ipc'
import { loadSettings } from './settings'
import { startReplyPipeline, rebindReplyWindow } from './ai/pipeline'
import type { DbStore } from './db/store'
import { registerHistoryIpc } from './db/historyIpc'
import { registerAuthIpc } from './auth/ipc'

/**
 * 无可用 GPU 的环境（虚拟机 / 远程桌面 / CI / 沙箱）里，Chromium 的 GPU 进程会反复崩溃并
 * 直接以 "GPU process isn't usable" 退出，应用根本起不来。显式关掉硬件加速即可。
 * 默认不开启，避免影响正常带显卡的桌面环境。
 * 用法：npm run dev:nogpu（等价于传 --no-gpu）或设 LDA_NO_GPU=1
 */
if (process.argv.includes('--no-gpu') || process.env['LDA_NO_GPU'] === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  // 关键：让 GPU 逻辑跑在浏览器主进程内，避免独立 GPU 进程启动失败直接把应用拖死
  app.commandLine.appendSwitch('in-process-gpu')
}

/**
 * 受限环境（虚拟机 / 沙箱）里 Chromium 的渲染进程沙箱会直接被杀掉
 * （表现为 WebContentsView 的 render-process-gone reason=killed，
 *  进而 loadURL 报 ERR_FAILED），此时需要全局关闭渲染进程沙箱。
 *
 * ⚠️ 这会削弱第三方直播间页面的隔离强度，**仅限开发环境使用**，务必显式提示。
 */
if (process.argv.includes('--no-sandbox')) {
  console.warn(
    '[security] Chromium 渲染进程沙箱已禁用（--no-sandbox）——仅限受限环境开发使用，请勿用于正式分发'
  )
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1080, minHeight: 640,
    show: false, autoHideMenuBar: true, backgroundColor: '#f3f0ff',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win.on('ready-to-show', () => win.show())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

/**
 * node:sqlite 目前仍是实验特性，且库文件可能因权限/磁盘问题打不开；
 * 用动态 import + try/catch 隔离，失败只降级为「不落盘」，不带崩主进程。
 */
async function openDb(): Promise<DbStore | null> {
  try {
    const mod = await import('./db/store')
    return new mod.DbStore(join(app.getPath('userData'), 'danmaku.db'))
  } catch (err) {
    console.warn('[db] 历史库不可用，留档已禁用：', err)
    return null
  }
}

app.whenReady().then(async () => {
  const win = createWindow()
  registerRoomIpc(win)
  registerAuthIpc(win)
  const db = await openDb()
  registerHistoryIpc(() => db)
  startReplyPipeline(win, loadSettings(), db)
  app.on('will-quit', () => db?.close())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createWindow()
      rebindRoomWindow(next)
      rebindReplyWindow(next)
    }
  })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
