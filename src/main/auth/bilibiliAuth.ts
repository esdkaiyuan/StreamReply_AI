import { BrowserWindow, type Session } from 'electron'
import QRCode from 'qrcode'
import type { LoginState, QrPhase, QrPollResult, QrSession } from '../../shared/types'
import { defaultSession, httpRequest } from '../net/http'
import { type CookiePair, hasSessionCookie, parseCookieInput, parseCookiePairs } from './cookie'

/**
 * B 站账号登录（扫码 / Cookie 两种方式）。
 *
 * 为什么需要：抓取弹幕不需登录（匿名直连即可收到弹幕），但**发送弹幕必须登录**——
 * 游客态页面根本不渲染输入框，发送脚本必然报 'need-login'。
 *
 * 登录结果写入 **默认会话**：主窗口、隐藏 WebView、会话态 HTTP 请求共用同一会话，
 * 登录一次即全局生效；登录成功后需重载各房间页面，页面才会切到已登录 UI。
 */

const NAV = 'https://api.bilibili.com/x/web-interface/nav'
const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const QR_POLL = (key: string): string =>
  `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`
const LOGIN_URL = 'https://passport.bilibili.com/login'

const COOKIE_DOMAIN = '.bilibili.com'
/** 发送弹幕必需的 Cookie：缺 csrf（bili_jct）时请求会被 B 站以 -111 拒绝 */
const REQUIRED_COOKIES = ['SESSDATA', 'bili_jct']

interface NavPayload {
  data?: { isLogin?: boolean; mid?: number; uname?: string }
}
interface QrGeneratePayload {
  code?: number
  message?: string
  data?: { url?: string; qrcode_key?: string }
}
interface QrPollPayload {
  code?: number
  data?: { code?: number; message?: string; url?: string }
}

interface WriteOutcome {
  /** 回读校验通过的条数 */
  verified: number
  /** 未通过校验的 Cookie 名 */
  failed: string[]
}

/**
 * 写入 Cookie 并**回读校验**。
 *
 * 必须校验的原因：本机 Chromium 网络服务会崩溃重启，此时 `cookies.set` 可能
 * 正常 resolve 但并未真正落库；只看返回值会把「没写进去」当成「登录成功」。
 */
async function writeCookies(ses: Session, pairs: CookiePair[]): Promise<WriteOutcome> {
  const failed: string[] = []
  for (const { name, value } of pairs) {
    try {
      await ses.cookies.set({
        url: 'https://www.bilibili.com',
        domain: COOKIE_DOMAIN,
        path: '/',
        name,
        value,
        secure: true
      })
    } catch {
      failed.push(name)
    }
  }
  let verified = 0
  for (const { name, value } of pairs) {
    try {
      const got = await ses.cookies.get({ name })
      if (got.some((c) => c.value === value)) verified += 1
      else if (!failed.includes(name)) failed.push(name)
    } catch {
      if (!failed.includes(name)) failed.push(name)
    }
  }
  return { verified, failed }
}

/** 把 Set-Cookie 写入默认会话；返回回读校验通过的条数 */
export async function applyCookies(setCookies: string[]): Promise<number> {
  const pairs = parseCookiePairs(setCookies)
  if (!pairs.length) return 0
  const outcome = await writeCookies(defaultSession(), pairs)
  if (outcome.failed.length) {
    console.warn('[auth] 以下 Cookie 未确认落库：', outcome.failed.join(','))
  }
  return outcome.verified
}

/** 解析用户粘贴的 Cookie 串（实现见 ./cookie，便于单测） */
export { parseCookieInput }

/** 当前登录态里缺失的关键 Cookie（用于提示「能读弹幕但发不出去」） */
async function missingRequiredCookies(): Promise<string[]> {
  const ses = defaultSession()
  const missing: string[] = []
  for (const name of REQUIRED_COOKIES) {
    const list = await ses.cookies.get({ name }).catch(() => [])
    if (!list.some((c) => c.value)) missing.push(name)
  }
  return missing
}

async function hasCookie(name: string): Promise<boolean> {
  const list = await defaultSession().cookies.get({ name }).catch(() => [])
  return list.some((c) => c.value)
}

/**
 * 补全 CSRF Cookie（`bili_jct`）。
 *
 * B 站把 `bili_jct` 当作发送类接口的 csrf 令牌。有些登录路径只会写入
 * `SESSDATA` / `DedeUserID`，不带它 —— 此时「能收弹幕但发不出去」（服务端 -111）。
 *
 * 实测（2026-09-16）：只要带着有效 SESSDATA 访问一次 `https://www.bilibili.com/`，
 * B 站就会补发 `bili_jct`（连带 `b_lsid`）。所以这里做一次静默补全，无需用户重新登录。
 */
export async function ensureCsrfCookie(): Promise<boolean> {
  if (await hasCookie('bili_jct')) return true
  let win: BrowserWindow | null = null
  try {
    win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
    await win.loadURL('https://www.bilibili.com/').catch(() => undefined)
    // 网络服务偶发崩溃重启，Set-Cookie 可能延迟落库 → 轮询几次再判定
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setTimeout(r, 600))
      if (await hasCookie('bili_jct')) return true
    }
    console.warn('[auth] 未能补全 bili_jct：发送弹幕可能被 B 站以 -111 拒绝，建议重新登录一次')
    return false
  } catch {
    return false
  } finally {
    try {
      win?.destroy()
    } catch {
      /* 忽略 */
    }
  }
}

/** 查询当前登录态（带缓存破坏，避免拿到旧的 nav 结果） */
export async function getLoginState(): Promise<LoginState> {
  try {
    const res = await httpRequest({ url: `${NAV}?t=${Date.now()}`, session: defaultSession() })
    const data = (res.json as NavPayload)?.data
    if (data?.isLogin) {
      let missing = await missingRequiredCookies()
      if (missing.includes('bili_jct')) {
        // 缺 CSRF 时静默补全一次，再复检，避免把「其实已可发送」误报成缺 Cookie
        if (await ensureCsrfCookie()) missing = await missingRequiredCookies()
      }
      return { isLogin: true, uid: data.mid, uname: data.uname, missingCookies: missing }
    }
    return { isLogin: false }
  } catch {
    return { isLogin: false }
  }
}

let currentQr: { key: string; expiresAt: number } | null = null

/** 生成扫码登录二维码（PNG data URL，渲染进程直接 <img> 展示，无 XSS 面） */
export async function startQrLogin(): Promise<QrSession> {
  const res = await httpRequest({ url: QR_GENERATE, referer: LOGIN_URL, session: defaultSession() })
  const payload = res.json as QrGeneratePayload
  const url = payload?.data?.url
  const key = payload?.data?.qrcode_key
  if (payload?.code !== 0 || !url || !key) {
    throw new Error(`生成二维码失败：${payload?.message ?? payload?.code ?? '未知错误'}`)
  }
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 240 })
  currentQr = { key, expiresAt: Date.now() + 180_000 }
  return { qrDataUrl, key, expiresAt: currentQr.expiresAt }
}

/**
 * 轮询扫码状态。
 * 成功时**显式**把响应里的 Set-Cookie 写进会话并回读校验——若本次走的是 Node 网络栈，
 * Cookie 不会自动落库，只靠自动落库会「扫码成功却没登录」。
 */
export async function pollQrLogin(key: string): Promise<QrPollResult> {
  if (!key) return { phase: 'error', message: '二维码已失效，请重新生成' }
  if (currentQr && currentQr.key === key && Date.now() > currentQr.expiresAt) {
    return { phase: 'expired', message: '二维码已过期，请重新生成' }
  }

  let res
  try {
    res = await httpRequest({ url: QR_POLL(key), referer: LOGIN_URL, session: defaultSession() })
  } catch (err) {
    return { phase: 'error', message: `网络异常：${String(err)}` }
  }
  const data = (res.json as QrPollPayload)?.data
  const code = data?.code

  if (code === 86101) return { phase: 'waiting-scan' }
  if (code === 86090) return { phase: 'scanned', message: '已扫码，请在手机上确认' }
  if (code === 86038) return { phase: 'expired', message: '二维码已过期，请重新生成' }
  if (code !== 0) return { phase: 'error', message: data?.message || `未知状态 code=${code ?? '?'}` }

  const verified = await applyCookies(res.setCookie)
  currentQr = null
  const state = await getLoginState()
  if (!state.isLogin) {
    return {
      phase: 'error',
      message:
        verified === 0
          ? '登录 Cookie 未能写入本地会话（网络服务异常），请重试或改用「打开登录窗口」'
          : '登录 Cookie 已写入但校验未通过，请重试'
    }
  }
  return { phase: 'confirmed', state }
}

/** Cookie 登录：写入会话后立即校验，避免「填了错 Cookie 却显示已登录」 */
export async function loginWithCookie(input: string): Promise<LoginState & { error?: string }> {
  const pairs = parseCookieInput(input)
  if (!pairs.length) return { isLogin: false, error: '未解析出任何 Cookie，请粘贴 a=1; b=2 形式的串' }
  if (!hasSessionCookie(pairs)) {
    return { isLogin: false, error: 'Cookie 里没有 SESSDATA，无法登录（SESSDATA 是 B 站的身份凭证）' }
  }
  const ses = defaultSession()
  // 先备份：粘贴错 Cookie 绝不能把已登录的会话冲掉（用户会莫名被登出）
  const backup = await ses.cookies.get({ domain: 'bilibili.com' }).catch(() => [])

  const outcome = await writeCookies(ses, pairs)
  if (outcome.verified === 0) {
    await restoreCookies(backup)
    return {
      isLogin: false,
      error: 'Cookie 未能写入本地会话（本机网络服务异常），请重试'
    }
  }

  const state = await getLoginState()
  if (!state.isLogin) {
    await restoreCookies(backup)
    return {
      isLogin: false,
      error:
        backup.length > 0
          ? 'Cookie 校验未通过（通常是 SESSDATA 已过期），已回滚到登录前的状态'
          : 'Cookie 已写入但校验未通过，通常是 SESSDATA 已过期'
    }
  }
  return { ...state, via: 'cookie' }
}

/** 回滚 Cookie 到备份快照 */
async function restoreCookies(snapshot: Electron.Cookie[]): Promise<void> {
  const ses = defaultSession()
  for (const c of snapshot) {
    try {
      await ses.cookies.set({
        url: `https://${c.domain?.replace(/^\./, '') ?? 'www.bilibili.com'}${c.path ?? '/'}`,
        domain: c.domain,
        path: c.path ?? '/',
        name: c.name,
        value: c.value,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate
      })
    } catch {
      /* 单条恢复失败不影响其余 */
    }
  }
}

/** 清空 B 站相关 Cookie（登出） */
export async function logout(): Promise<void> {
  const ses = defaultSession()
  const cookies = await ses.cookies.get({ domain: 'bilibili.com' })
  await Promise.all(
    cookies.map((c) =>
      ses.cookies
        .remove(`https://${c.domain?.replace(/^\./, '') ?? 'www.bilibili.com'}${c.path ?? '/'}`, c.name)
        .catch(() => undefined)
    )
  )
  currentQr = null
}

/**
 * 打开可见登录窗口（B 站官方登录页）。
 * 作为扫码/Cookie 之外的兜底：B 站改版登录流程时这条路仍然可用，
 * 且能拿到最完整的 Cookie 集合（含 bili_jct）。
 */
export function openLoginWindow(onSuccess: () => void): void {
  const win = new BrowserWindow({
    width: 460,
    height: 640,
    title: 'B 站登录（登录成功后本窗口会自动关闭）',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  void win.loadURL(LOGIN_URL)

  const timer = setInterval(async () => {
    if (win.isDestroyed()) {
      clearInterval(timer)
      return
    }
    const state = await getLoginState()
    if (state.isLogin) {
      clearInterval(timer)
      win.close()
      onSuccess()
    }
  }, 2000)
  win.on('closed', () => clearInterval(timer))
}

export const loginPageUrl = LOGIN_URL
export type { QrPhase }
