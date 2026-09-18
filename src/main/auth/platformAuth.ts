/**
 * 多平台账号管理：扫码/窗口登录 → 抓 Cookie 保存 → 多账号切换。
 *
 * 设计要点：
 * - Cookie 从 defaultSession 里按平台域导出后持久化到 electron-store；
 *   「切换账号」= 清该平台域 cookie → 写回选中账号的 cookie → 重载房间页
 * - 各平台的「关键登录 Cookie」用于判定登录成功（登录窗口轮询它）
 * - B 站不在这里（bilibiliAuth 已有完整实现，UI 也独立）
 */
import Store from 'electron-store'
import { session } from 'electron'
import type { Platform, PlatformAccount, PlatformAccountSnapshot } from '../../shared/types'
import { reloadAllRooms } from '../webview/webviewManager'
import {
  ensureCsrfCookie,
  getLoginState as getBiliLoginState,
  pollQrLogin as biliPollQrLogin,
  startQrLogin as biliStartQrLogin
} from './bilibiliAuth'
import { platformQrGenerate, platformQrPoll } from './platformQr'

interface StoredAccount {
  id: string
  uname: string
  savedAt: number
  /** 序列化的 Cookie 列表（写回 session 时还原） */
  cookies: Array<{ name: string; value: string; domain?: string; path?: string }>
}

interface PlatformAccountStore {
  activeId: string | null
  list: StoredAccount[]
}

const store = new Store<{ accounts?: Partial<Record<Platform, PlatformAccountStore>> }>({
  name: 'platform-accounts'
})

/** 各平台登录配置：登录页 / 会话归属域 / 判定登录成功的关键 Cookie */
export const PLATFORM_LOGIN: Record<Platform, {
  loginUrl: string; domain: string; sessionCookies: string[]; label: string
}> = {
  bilibili: {
    loginUrl: 'https://passport.bilibili.com/login',
    domain: 'bilibili.com',
    sessionCookies: ['SESSDATA'],
    label: 'B站'
  },
  douyin: {
    loginUrl: 'https://www.douyin.com/login',
    domain: 'douyin.com',
    sessionCookies: ['sessionid', 'sessionid_ss'],
    label: '抖音'
  },
  douyu: {
    loginUrl: 'https://www.douyu.com/',
    domain: 'douyu.com',
    sessionCookies: ['acf_uid', 'yyuid'],
    label: '斗鱼'
  },
  huya: {
    loginUrl: 'https://www.huya.com/',
    domain: 'huya.com',
    sessionCookies: ['yyuid', 'udb_passdata'],
    label: '虎牙'
  },
  kuaishou: {
    // www.kuaishou.com 会 302 到 /new-reco 的 JSON feed（非登录页）；用直播域，首页右上角「登录」点开即扫码框
    loginUrl: 'https://live.kuaishou.com/',
    domain: 'kuaishou.com',
    sessionCookies: ['passToken', 'kuaishou.server.webday7_st'],
    label: '快手'
  }
}

function sesFor(_platform: Platform): Electron.Session {
  return session.defaultSession
}

/** 平台配置（bilibili 也并入统一体系） */
function cfgOf(platform: Platform): (typeof PLATFORM_LOGIN)[Platform] {
  return PLATFORM_LOGIN[platform]
}

/**
 * 逐条删除某域（含子域）的全部 Cookie。
 * ⚠️ 不能用 clearStorageData({ origin })：它清不到子域 Cookie（如 api.bilibili.com
 * 的 SESSDATA），而且 cookies.set 无法覆盖已存在的 HttpOnly Cookie —— 必须先删后写。
 */
async function clearDomainCookies(domain: string): Promise<void> {
  const ses = session.defaultSession
  const list = await ses.cookies.get({ domain })
  await Promise.all(
    list.map((c) =>
      ses.cookies
        .remove(`https://${c.domain?.replace(/^\./, '') ?? domain}${c.path ?? '/'}`, c.name)
        .catch(() => undefined)
    )
  )
}

function readStore(platform: Platform): PlatformAccountStore {
  const all = store.get('accounts') ?? {}
  return all[platform] ?? { activeId: null, list: [] }
}

function writeStore(platform: Platform, data: PlatformAccountStore): void {
  const all = store.get('accounts') ?? {}
  all[platform] = data
  store.set('accounts', all)
}

/** 该平台域下当前生效的 Cookie（导出用） */
async function exportDomainCookies(platform: Platform): Promise<StoredAccount['cookies']> {
  const cfg = cfgOf(platform)
  if (!cfg) return []
  const list = await sesFor(platform).cookies.get({ domain: cfg.domain })
  return list
    .filter((c) => c.value)
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }))
}

function hasAny(list: StoredAccount['cookies'], names: string[]): string | null {
  for (const n of names) {
    const hit = list.find((c) => c.name === n && c.value)
    if (hit) return hit.value
  }
  return null
}

/** 从当前会话判定登录态并返回展示名（uid 优先，无则「已登录」） */
async function currentLogin(platform: Platform): Promise<{ isLogin: boolean; uname?: string }> {
  if (platform === 'bilibili') {
    // B 站用 nav API 真实校验（Cookie 存在 ≠ 有效），顺带拿昵称
    const st = await getBiliLoginState()
    return st.isLogin ? { isLogin: true, uname: st.uname ?? 'B站用户' } : { isLogin: false }
  }
  const cfg = cfgOf(platform)
  if (!cfg) return { isLogin: false }
  const list = await sesFor(platform).cookies.get({ domain: cfg.domain })
  const uid = hasAny(list, cfg.sessionCookies)
  if (!uid) return { isLogin: false }
  // 昵称类 cookie（各平台不同，能拿到就展示）
  const nick = hasAny(list, ['acf_nickname', 'username', 'user_name'])
  return { isLogin: true, uname: nick ? decodeURIComponent(nick) : `账号 ${uid.slice(0, 10)}` }
}

/**
 * 统一扫码入口：B 站有原生二维码接口（真扫码）；其余平台的二维码在
 * 官方登录页里（用 openPlatformLoginWindow 打开），这里返回 not-supported。
 */
export async function startPlatformQr(platform: Platform): Promise<{
  ok: boolean
  session?: { qrDataUrl: string; key: string; expiresAt: number }
  error?: string
}> {
  if (platform === 'bilibili') {
    try {
      return { ok: true, session: await biliStartQrLogin() }
    } catch (err) {
      return { ok: false, error: String(err).replace(/^Error:\s*/, '') }
    }
  }
  // 快手 / 斗鱼：原生接口直出
  return platformQrGenerate(platform)
}

export async function pollPlatformQr(
  platform: Platform,
  key: string
): Promise<{ phase: string; message?: string; state?: PlatformAccountSnapshot }> {
  if (platform !== 'bilibili') {
    const res = await platformQrPoll(platform, key)
    if (res.phase === 'confirmed') {
      await saveCurrentAccount(platform).catch(() => undefined)
      return { phase: 'confirmed', state: await getAccountSnapshot(platform) }
    }
    return { phase: res.phase, message: res.message }
  }
  const res = await biliPollQrLogin(key)
  if (res.phase === 'confirmed') {
    await saveCurrentAccount(platform).catch(() => undefined)
    return { phase: 'confirmed', state: await getAccountSnapshot(platform) }
  }
  return { phase: res.phase, message: res.message }
}

/** 快照：登录态 + 账号列表 + 激活 id */
export async function getAccountSnapshot(platform: Platform): Promise<PlatformAccountSnapshot> {
  const cur = await currentLogin(platform)
  const data = readStore(platform)
  const accounts: PlatformAccount[] = data.list.map((a) => ({
    id: a.id,
    uname: a.uname,
    savedAt: a.savedAt
  }))
  return {
    platform,
    isLogin: cur.isLogin,
    uname: cur.uname,
    accounts,
    activeId: data.activeId
  }
}

/** 把当前会话的登录态保存为一个账号并激活（登录成功后调用） */
export async function saveCurrentAccount(platform: Platform): Promise<PlatformAccountSnapshot> {
  const cfg = cfgOf(platform)
  if (!cfg) throw new Error(`平台 ${platform} 不支持账号管理`)
  const cookies = await exportDomainCookies(platform)
  const uid = hasAny(cookies, cfg.sessionCookies)
  if (!uid) throw new Error('当前会话没有该平台的登录 Cookie，请先完成登录')
  const cur = await currentLogin(platform)
  const data = readStore(platform)
  // 同一身份（关键 Cookie 值相同）覆盖旧账号，否则新增
  const existing = data.list.find((a) => {
    const hit = a.cookies.find((c) => cfg.sessionCookies.includes(c.name) && c.value)
    return hit && hit.value === uid
  })
  const account: StoredAccount = existing ?? {
    id: `${platform}-${Date.now()}`,
    uname: '',
    savedAt: Date.now(),
    cookies
  }
  account.uname = cur.uname ?? account.uname ?? `账号 ${uid.slice(0, 10)}`
  account.cookies = cookies
  if (!existing) data.list.unshift(account)
  data.activeId = account.id
  writeStore(platform, data)
  return getAccountSnapshot(platform)
}

/**
 * 进房前的会话重置（虎牙等平台声明时使用，见 adapters/huya 的 resetSession）。
 *
 * 为什么不能像旧实现那样无脑清 Cookie：虎牙进房前清 huya.com Cookie 是规避
 * 「房间页被 302 到错误页」的手段，但它同时抹掉了登录态 —— 于是虎牙永远停在
 * 游客态、发送链路必然失败。这里按登录态分流：
 * - 该平台有激活账号 → 清空后写回该账号保存的 Cookie：既拿到「干净」的登录会话
 *   （避免历史混杂 Cookie 触发 302），又保住登录态；
 * - 无激活账号（游客）→ 只清该平台域 Cookie，走原有的「重新获取游客身份」路径。
 *
 * 不触发 reloadAllRooms：它在 openRoom 进房前被调用，此时页面尚未加载。
 */
export async function resetSessionPreserveLogin(platform: Platform): Promise<void> {
  const cfg = cfgOf(platform)
  if (!cfg) return
  const data = readStore(platform)
  const active = data.activeId ? data.list.find((a) => a.id === data.activeId) : null
  if (active && active.cookies.length > 0) {
    await applyAccountCookies(platform, active.cookies)
    return
  }
  await sesFor(platform).clearStorageData({
    origin: `https://www.${cfg.domain}`,
    storages: ['cookies']
  })
}

/** 把某账号的 Cookie 写回会话（切换账号 / 会话重置复用） */
async function applyAccountCookies(
  platform: Platform,
  cookies: StoredAccount['cookies']
): Promise<void> {
  const cfg = cfgOf(platform)
  const ses = sesFor(platform)
  // 先清该平台域的现有 cookie，避免两账号字段混杂
  await ses.clearStorageData({ origin: `https://www.${cfg.domain}`, storages: ['cookies'] })
  for (const c of cookies) {
    const url = `https://www.${cfg.domain}/`
    await session.defaultSession.cookies.set({
      url,
      name: c.name,
      value: c.value,
      domain: c.domain ?? `.${cfg.domain}`,
      path: c.path ?? '/',
      secure: true,
      httpOnly: false
    })
  }
}

/** 切换账号：写回 Cookie → 重载房间页 */
export async function switchAccount(platform: Platform, id: string): Promise<PlatformAccountSnapshot> {
  const data = readStore(platform)
  const target = data.list.find((a) => a.id === id)
  if (!target) throw new Error('账号不存在')
  await applyAccountCookies(platform, target.cookies)
  data.activeId = id
  writeStore(platform, data)
  if (platform === 'bilibili') await ensureCsrfCookie().catch(() => undefined) // 补 bili_jct，否则发弹幕 -111
  reloadAllRooms()
  return getAccountSnapshot(platform)
}

/** 删除账号；若删的是激活账号则清会话（回到未登录） */
export async function removeAccount(platform: Platform, id: string): Promise<PlatformAccountSnapshot> {
  const data = readStore(platform)
  data.list = data.list.filter((a) => a.id !== id)
  if (data.activeId === id) {
    data.activeId = data.list[0]?.id ?? null
    if (data.activeId) {
      const first = data.list[0]
      await applyAccountCookies(platform, first.cookies)
    } else {
      await clearDomainCookies(cfgOf(platform).domain)
    }
  }
  writeStore(platform, data)
  reloadAllRooms()
  return getAccountSnapshot(platform)
}

/** 退出当前登录（清会话 + 取消激活；账号记录保留，可随时切换回来） */
export async function platformLogout(platform: Platform): Promise<PlatformAccountSnapshot> {
  if (platform in PLATFORM_LOGIN) {
    await clearDomainCookies(PLATFORM_LOGIN[platform].domain)
  }
  const data = readStore(platform)
  data.activeId = null
  writeStore(platform, data)
  reloadAllRooms()
  return getAccountSnapshot(platform)
}

/** Cookie 导入登录：解析粘贴文本 → 写入会话 → 保存为账号 */
export async function platformCookieLogin(
  platform: Platform,
  raw: string
): Promise<PlatformAccountSnapshot> {
  const pairs = raw
    .split(/[\n;]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('=')
      return i > 0 ? { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : null
    })
    .filter((x): x is { name: string; value: string } => !!x)
  if (!pairs.length) throw new Error('未能解析出任何 Cookie，请检查格式（name=value; ...）')
  const cfg = cfgOf(platform)
  const ses = sesFor(platform)
  for (const c of pairs) {
    await ses.cookies.set({
      url: `https://www.${cfg.domain}/`,
      name: c.name,
      value: c.value,
      domain: `.${cfg.domain}`,
      path: '/',
      secure: true
    })
  }
  const cur = await currentLogin(platform)
  if (!cur.isLogin) {
    throw new Error(`Cookie 已写入但未见登录标识（缺 ${cfg.sessionCookies.join(' 或 ')}），请确认复制的是登录后的 Cookie`)
  }
  return saveCurrentAccount(platform)
}
