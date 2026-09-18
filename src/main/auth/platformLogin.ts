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

/**
 * 自动点开登录框的启发式脚本（注入到登录窗口）。
 *
 * 四平台的扫码登录都是「首页里的 JS 弹窗」：直接加载首页只会看到一个登录按钮，
 * 二维码并不自动出现。故页面加载后自动：
 *   1) 点可见的「登录/立即登录」入口打开登录框；
 *   2) 若框内有「扫码/扫一扫/二维码」标签，点它切到扫码态。
 * 用文本匹配 + 可见性过滤（offsetParent 非空）跨平台通用；已在扫码态则不重复点。
 */
const AUTO_OPEN_LOGIN = String.raw`(function () {
  function clickFirst(re) {
    var els = document.querySelectorAll('a,button,span,div,p,li,[role="button"]')
    for (var i = 0; i < els.length; i++) {
      var el = els[i]
      if (el.offsetParent === null) continue
      var t = (el.innerText || el.textContent || '').trim()
      if (t && t.length <= 8 && re.test(t)) {
        try {
          el.click()
          return t
        } catch (e) {}
      }
    }
    return ''
  }
  var qr = document.querySelector('canvas, img[src*="qrcode" i], img[src*="qr" i]')
  if (qr && qr.offsetParent !== null) return 'qr-present'
  clickFirst(/^(登录|登陆|立即登录|扫码登录|Login|Sign in)$/i)
  clickFirst(/^(扫码登录|扫一扫|二维码|APP扫码|扫码)$/i)
  return 'clicked'
})()`

/** 打开某平台的登录窗口；检测到登录成功后自动关闭并保存账号 */
export function openPlatformLoginWindow(
  platform: Platform,
  onSaved: (platform: Platform) => void
): { ok: true } {
  const cfg = PLATFORM_LOGIN[platform]
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

  // 登录框是首页里的 JS 弹窗：页面就绪后自动点开登录入口 + 切扫码标签（多轮重试，容错异步渲染）
  const tryOpenLogin = (): void => {
    if (win.isDestroyed()) return
    win.webContents.executeJavaScript(AUTO_OPEN_LOGIN).catch(() => {
      /* 页面导航中/脚本失败：下一轮再试 */
    })
  }
  win.webContents.on('dom-ready', () => {
    tryOpenLogin()
    setTimeout(tryOpenLogin, 1500)
    setTimeout(tryOpenLogin, 3500)
  })

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
