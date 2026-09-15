import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../shared/types'
import { reloadAllRooms } from '../webview/webviewManager'
import {
  getLoginState,
  loginWithCookie,
  logout,
  openLoginWindow,
  pollQrLogin,
  startQrLogin
} from './bilibiliAuth'

/**
 * 登录相关 IPC。
 * 登录成功后统一「重载房间页面」，让游客态页面切换到已登录 UI（出现弹幕输入框）。
 */
export function registerAuthIpc(win: BrowserWindow): void {
  const broadcast = async (): Promise<void> => {
    const state = await getLoginState()
    win.webContents.send(IPC.authChanged, state)
  }

  ipcMain.handle(IPC.authState, () => getLoginState())

  ipcMain.handle(IPC.authQrStart, async () => {
    try {
      return { ok: true as const, session: await startQrLogin() }
    } catch (err) {
      return { ok: false as const, error: String(err) }
    }
  })

  ipcMain.handle(IPC.authQrPoll, async (_e, key: string) => {
    const result = await pollQrLogin(key)
    if (result.phase === 'confirmed') {
      reloadAllRooms()
      await broadcast()
    }
    return result
  })

  ipcMain.handle(IPC.authCookieSet, async (_e, raw: string) => {
    const result = await loginWithCookie(raw)
    if (result.isLogin) {
      reloadAllRooms()
      await broadcast()
    }
    return result
  })

  ipcMain.handle(IPC.authOpenLoginWindow, () => {
    openLoginWindow(() => {
      reloadAllRooms()
      void broadcast()
    })
    return { ok: true as const }
  })

  ipcMain.handle(IPC.authLogout, async () => {
    await logout()
    reloadAllRooms()
    await broadcast()
    return { isLogin: false }
  })
}
