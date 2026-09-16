import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, describe, expect, it } from 'vitest'
import { cookieDbHasSession } from '../src/main/auth/cookieDb'

const dir = mkdtempSync(join(tmpdir(), 'lda-cookiedb-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** 造一个结构最小但足够真实的 Chromium Cookies 库 */
function makeCookieDb(names: string[]): string {
  const file = join(dir, `Cookies-${Math.random().toString(36).slice(2)}`)
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, path TEXT, expires_utc INTEGER)'
  )
  for (const name of names) {
    db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?)').run(
      '.bilibili.com',
      name,
      'v',
      '/',
      0
    )
  }
  db.close()
  return file
}

describe('Cookie 库登录检测', () => {
  it('含 SESSDATA 视为已登录', () => {
    expect(cookieDbHasSession(makeCookieDb(['buvid3', 'SESSDATA', 'bili_jct']))).toBe(true)
  })

  it('不含 SESSDATA 视为未登录', () => {
    expect(cookieDbHasSession(makeCookieDb(['buvid3', 'buvid4']))).toBe(false)
  })

  it('空库视为未登录', () => {
    expect(cookieDbHasSession(makeCookieDb([]))).toBe(false)
  })

  it('文件不存在不抛异常，返回 false', () => {
    expect(cookieDbHasSession(join(dir, 'not-exists'))).toBe(false)
  })

  it('文件不是合法 SQLite 时返回 false（不能因此让启动失败）', () => {
    const bad = join(dir, 'garbage')
    writeFileSync(bad, 'this is not a sqlite database at all')
    expect(cookieDbHasSession(bad)).toBe(false)
  })
})
