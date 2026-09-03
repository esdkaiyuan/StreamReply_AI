import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerRoomIpc, rebindRoomWindow } from './rooms/ipc'

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

app.whenReady().then(() => {
  const win = createWindow()
  registerRoomIpc(win)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) rebindRoomWindow(createWindow())
  })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
