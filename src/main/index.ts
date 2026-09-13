import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerRoomIpc, rebindRoomWindow } from './rooms/ipc'
import { loadSettings } from './settings'
import { startReplyPipeline, rebindReplyWindow } from './ai/pipeline'
import { DbStore } from './db/store'

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

/** 原生模块未针对 Electron ABI 重建时降级为「不落盘」，不影响主链路 */
function openDb(): DbStore | null {
  try {
    return new DbStore(join(app.getPath('userData'), 'danmaku.db'))
  } catch (err) {
    console.warn('[db] 初始化失败，历史留档已禁用：', err)
    return null
  }
}

app.whenReady().then(() => {
  const win = createWindow()
  registerRoomIpc(win)
  const db = openDb()
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
