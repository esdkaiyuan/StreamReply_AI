import { DatabaseSync } from 'node:sqlite'

/**
 * 判断一个 Chromium Cookies 数据库里是否存在有效的登录态（`SESSDATA`）。
 *
 * 用途：启动时决定要不要把「旧 userData 目录」的登录 Cookie 迁移过来。
 * 因此必须**绝不抛异常** —— 文件缺失、被占用、不是 SQLite 都只当作「没有登录」，
 * 否则一个探测动作会把应用启动带崩。
 */
export function cookieDbHasSession(file: string): boolean {
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    const row = db.prepare("SELECT COUNT(*) AS n FROM cookies WHERE name = 'SESSDATA'").get() as
      | { n?: number }
      | undefined
    return Number(row?.n ?? 0) > 0
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      /* 忽略关闭失败 */
    }
  }
}
