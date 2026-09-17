import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../shared/types'
import type { Platform } from '../../shared/types'
import { reloadAllRooms } from '../webview/webviewManager'
import {
  getAccountSnapshot,
  platformCookieLogin,
  platformLogout,
  removeAccount,
  switchAccount
} from './platformAuth'
import { openPlatformLoginWindow } from './platformLogin'
import {
  getLoginState as getBiliLoginState,
  loginWithCookie as biliLoginWithCookie,
  logout,
  openLoginWindow,
  pollQrLogin,
  startQrLogin
} from './bilibiliAuth'

/** 非 B 站平台走多平台账号体系；B 站保持原路径（已有完整实现与 UI） */
function isMultiPlatform(p: string): p is Exclude<Platform, 'bilibili'> {
  return p === 'douyin' || p === 'douyu' || p === 'huya' || p === 'kuaishou'
}

/**
 * 登录相关 IPC。
 * 登录成功后统一「重载房间页面」，让游客态页面切换到已登录 UI（出现弹幕输入框）。
 */
export function registerAuthIpc(win: BrowserWindow): void {
  const broadcast = async (): Promise<void> => {
    const state = await getBiliLoginState()
    win.webContents.send(IPC.authChanged, state)
  }
  const broadcastPlatform = async (platform: Platform): Promise<void> => {
    win.webContents.send(IPC.authChanged, await getBiliLoginState())
  }

  ipcMain.handle(IPC.authState, () => getBiliLoginState())

  // ---- 多平台账号体系 ----
  ipcMain.handle(IPC.authPlatformState, (_e, platform: string) =>
    isMultiPlatform(platform) ? getAccountSnapshot(platform) : getBiliLoginState()
  )

  ipcMain.handle(IPC.authPlatformLoginWindow, (_e, platform: string) => {
    if (!isMultiPlatform(platform)) return { ok: false, error: `平台 ${platform} 暂不支持` }
    return openPlatformLoginWindow(platform, (p) => {
      void broadcastPlatform(p)
    })
  })

  ipcMain.handle(IPC.authPlatformCookieSet, async (_e, platform: string, raw: string) => {
    if (!isMultiPlatform(platform)) return { ok: false, error: `平台 ${platform} 暂不支持` }
    try {
      const snap = await platformCookieLogin(platform, raw)
      reloadAllRooms()
      await broadcastPlatform(platform)
      return { ok: true as const, snapshot: snap }
    } catch (err) {
      return { ok: false as const, error: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipcMain.handle(IPC.authPlatformSwitch, async (_e, platform: string, id: string) => {
    if (!isMultiPlatform(platform)) return { ok: false, error: `平台 ${platform} 暂不支持` }
    try {
      const snap = await switchAccount(platform, id)
      await broadcastPlatform(platform)
      return { ok: true as const, snapshot: snap }
    } catch (err) {
      return { ok: false as const, error: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipcMain.handle(IPC.authPlatformRemove, async (_e, platform: string, id: string) => {
    if (!isMultiPlatform(platform)) return { ok: false, error: `平台 ${platform} 暂不支持` }
    try {
      const snap = await removeAccount(platform, id)
      await broadcastPlatform(platform)
      return { ok: true as const, snapshot: snap }
    } catch (err) {
      return { ok: false as const, error: String(err).replace(/^Error:\s*/, '') }
    }
  })

  ipcMain.handle(IPC.authPlatformLogout, async (_e, platform: string) => {
    if (!isMultiPlatform(platform)) return { ok: false, error: `平台 ${platform} 暂不支持` }
    try {
      const snap = await platformLogout(platform)
      reloadAllRooms()
      await broadcastPlatform(platform)
      return { ok: true as const, snapshot: snap }
    } catch (err) {
      return { ok: false as const, error: String(err).replace(/^Error:\s*/, '') }
    }
  })

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
    const result = await biliLoginWithCookie(raw)
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
