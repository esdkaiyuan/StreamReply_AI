import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { cookieDbHasSession } from './auth/cookieDb'

/** 固定的应用数据目录名 */
const APP_DIR = 'live-danmaku-assistant'
/** 直接 `electron out/main/index.js` 启动时，Electron 会退回的默认应用名 */
const LEGACY_DIR = 'Electron'
/** 迁移只做一次，用标记文件记账 */
const MARKER = '.cookie-migrated'

/**
 * 统一 userData 目录。
 *
 * 为什么必须钉死：同一份代码在不同启动方式下会用到**三个不同的目录** ——
 * - `npm run dev` / `electron-vite`：app path 是项目根，取 package.json 的 `name`
 * - 直接 `electron out/main/index.js`：找不到 package.json，Electron 用默认名 `Electron`
 * - 打包后：用 electron-builder 的 `productName`
 *
 * 于是会出现「换个启动方式就变成没登录」——Cookie 库登录信息留在另一个目录里，
 * 表现为「能收弹幕但发不出」（游客态页面不渲染弹幕输入框）。
 *
 * 必须在任何 userData 访问（electron-store、session、db）之前调用。
 */
export function setupUserData(): void {
  // LDA_USER_DATA：隔离测试用临时目录（冒烟/多实例验证时不打扰正在运行的正式实例）
  const override = process.env.LDA_USER_DATA
  if (override) {
    app.setPath('userData', override)
    console.log('[userData] 使用隔离目录（LDA_USER_DATA）：', override)
    return
  }
  app.setPath('userData', join(app.getPath('appData'), APP_DIR))
  migrateLegacyCookies()
}

/**
 * 一次性把旧目录里的登录 Cookie 迁到统一目录。
 *
 * 只在「统一目录没有登录，而旧目录有登录」时复制，并先备份原文件；
 * 任何失败都只打日志 —— 宁可让用户重新登录一次，也不能影响启动。
 */
function migrateLegacyCookies(): void {
  try {
    const mineDir = app.getPath('userData')
    const marker = join(mineDir, MARKER)
    if (existsSync(marker)) return

    const mine = join(mineDir, 'Network', 'Cookies')
    const legacy = join(app.getPath('appData'), LEGACY_DIR, 'Network', 'Cookies')

    if (!existsSync(legacy)) return mark(marker, 'no-legacy-dir')
    if (cookieDbHasSession(mine)) return mark(marker, 'already-logged-in')
    if (!cookieDbHasSession(legacy)) return mark(marker, 'legacy-has-no-login')

    mkdirSync(dirname(mine), { recursive: true })
    if (existsSync(mine)) copyFileSync(mine, `${mine}.bak`)
    copyFileSync(legacy, mine)
    const legacyJournal = `${legacy}-journal`
    if (existsSync(legacyJournal)) copyFileSync(legacyJournal, `${mine}-journal`)
    console.log(
      `[auth] 已从旧 userData 迁移登录 Cookie：%APPDATA%/${LEGACY_DIR} → ${APP_DIR}`
    )
    mark(marker, 'migrated')
  } catch (err) {
    // 不写标记：目标文件被占用等情况下，下次启动再试
    console.warn('[auth] 迁移登录 Cookie 失败（不影响启动，重新登录即可）：', String(err))
  }
}

function mark(marker: string, reason: string): void {
  try {
    writeFileSync(marker, `${reason}\n`, 'utf8')
  } catch {
    /* 写不了标记也无所谓，最多每次启动多探测一次 */
  }
}
