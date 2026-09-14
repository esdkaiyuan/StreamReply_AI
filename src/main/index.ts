import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerRoomIpc, rebindRoomWindow } from './rooms/ipc'
import { loadSettings } from './settings'
import { startReplyPipeline, rebindReplyWindow } from './ai/pipeline'
import type { DbStore } from './db/store'
import { registerHistoryIpc } from './db/historyIpc'

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
