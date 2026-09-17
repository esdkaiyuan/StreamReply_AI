/**
 * 多平台登录窗口：打开平台官方登录页（用户可用平台自带的二维码扫码、
 * 账号密码、第三方授权等任何方式），轮询到关键登录 Cookie 后自动关闭并保存账号。
 *
 * 这是二维码登录的通用兜底 —— 平台自带二维码就是「对应的平台登录二维码」，
 * 不需要我们逆向各家私有二维码接口。
 */
import { BrowserWindow } from 'electron'
import type { Platform } from '../../shared/types'
import { PLATFORM_LOGIN, saveCurrentAccount } from './platformAuth'

const openWindows = new Set<BrowserWindow>()

/** 打开某平台的登录窗口；检测到登录成功后自动关闭并保存账号 */
export function openPlatformLoginWindow(
  platform: Platform,
  onSaved: (platform: Platform) => void
): { ok: true } {
  const cfg = PLATFORM_LOGIN[platform as Exclude<Platform, 'bilibili'>]
  if (!cfg) return { ok: true }
  if (openWindows.size >= 2) return { ok: true } // 防止堆窗口

  const win = new BrowserWindow({
    width: 480,
    height: 680,
    title: `${cfg.label} 登录（扫码 / 账号密码均可，成功后自动关闭）`,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  openWindows.add(win)
  void win.loadURL(cfg.loginUrl)

  let tries = 0
  const timer = setInterval(async () => {
    if (win.isDestroyed()) {
      clearInterval(timer)
      openWindows.delete(win)
      return
    }
    tries += 1
    if (tries > 600) {
      // 20 分钟自动放弃，避免常驻定时器
      clearInterval(timer)
      win.close()
      return
    }
    try {
      const list = await win.webContents.session.cookies.get({ domain: cfg.domain })
      const loggedIn = cfg.sessionCookies.some((n) => list.some((c) => c.name === n && c.value))
      if (loggedIn) {
        clearInterval(timer)
        await saveCurrentAccount(platform)
        win.close()
        onSaved(platform)
      }
    } catch {
      /* 轮询失败下一轮再试 */
    }
  }, 2000)
  win.on('closed', () => {
    clearInterval(timer)
    openWindows.delete(win)
  })
  return { ok: true }
}
