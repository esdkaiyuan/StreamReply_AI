import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import type {
  DanmakuMessage,
  HistoryDanmaku,
  HistoryQuery,
  HistoryReply,
  ReplyTask
} from '../../shared/types'

const FLUSH_INTERVAL_MS = 2000
const MAX_LIMIT = 500

/** LIKE 元字符转义，配合 ESCAPE '\' 使用，避免用户输入的 % / _ 变成通配符 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return 100
  return Math.min(Math.max(Math.trunc(limit as number), 1), MAX_LIMIT)
}

function clampOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset)) return 0
  return Math.max(Math.trunc(offset as number), 0)
}

interface Filter {
  clause: string
  args: SQLInputValue[]
}

/** 只用 `?` 位置参数拼接，关键词走绑定，杜绝注入 */
function buildFilter(q: HistoryQuery, searchFields: string[]): Filter {
  const where: string[] = []
  const args: SQLInputValue[] = []
  if (q.roomId) {
    where.push('room_id = ?')
    args.push(q.roomId)
  }
  const kw = q.keyword?.trim()
  if (kw) {
    where.push(`(${searchFields.map((f) => `${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    const pattern = `%${escapeLike(kw)}%`
    for (const _ of searchFields) args.push(pattern)
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args }
}

/**
 * 历史留档。使用 Node 22 / Electron 37 内置的 node:sqlite，
 * 无需原生编译（better-sqlite3 需要 VS 构建工具，本机不可用）。
 */
export class DbStore {
  private db: DatabaseSync
  private buffer: DanmakuMessage[] = []
  private timer: NodeJS.Timeout | null = null
  private stmtInsert: StatementSync
  private stmtReply: StatementSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS danmaku (
        id TEXT PRIMARY KEY, platform TEXT, room_id TEXT, type TEXT,
        uid TEXT, nickname TEXT, content TEXT, source TEXT, ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS replies (
        id TEXT PRIMARY KEY, room_id TEXT, reply_to TEXT, text TEXT,
        emotion TEXT, status TEXT, created_at INTEGER, sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_danmaku_ts ON danmaku (ts);
      CREATE INDEX IF NOT EXISTS idx_replies_created ON replies (created_at);
    `)
    this.stmtInsert = this.db.prepare(
      `INSERT OR IGNORE INTO danmaku (id, platform, room_id, type, uid, nickname, content, source, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    this.stmtReply = this.db.prepare(
      `INSERT OR REPLACE INTO replies (id, room_id, reply_to, text, emotion, status, created_at, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
  }

  /** 弹幕入缓冲，每 2 秒事务批量写（热门房间限流写盘） */
  enqueueDanmaku(msg: DanmakuMessage): void {
    this.buffer.push(msg)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.buffer.length) return
    const rows = this.buffer.splice(0, this.buffer.length)
    this.db.exec('BEGIN')
    try {
      for (const m of rows) {
        this.stmtInsert.run(
          m.id,
          m.platform,
          m.roomId,
          m.type,
          m.user.uid,
          m.user.nickname,
          m.content,
          m.source,
          m.ts
        )
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  saveReply(t: ReplyTask): void {
    this.stmtReply.run(
      t.id,
      t.roomId,
      t.replyTo,
      t.text,
      t.emotion,
      t.status,
      t.createdAt,
      t.sentAt ?? null
    )
  }

  queryDanmaku(q: HistoryQuery = {}): HistoryDanmaku[] {
    this.flush() // 先落盘，保证刚捕获的弹幕立刻可查
    const { clause, args } = buildFilter(q, ['content', 'nickname'])
    const stmt = this.db.prepare(
      `SELECT id, platform, room_id, type, uid, nickname, content, source, ts
       FROM danmaku ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`
    )
    return (stmt.all(...args, clampLimit(q.limit), clampOffset(q.offset)) as unknown as RawDanmaku[]).map(
      (r) => ({
        id: r.id,
        platform: r.platform as HistoryDanmaku['platform'],
        roomId: r.room_id,
        type: r.type as HistoryDanmaku['type'],
        uid: r.uid,
        nickname: r.nickname,
        content: r.content,
        source: r.source as HistoryDanmaku['source'],
        ts: r.ts
      })
    )
  }

  queryReplies(q: HistoryQuery = {}): HistoryReply[] {
    const { clause, args } = buildFilter(q, ['text', 'reply_to'])
    const stmt = this.db.prepare(
      `SELECT id, room_id, reply_to, text, emotion, status, created_at, sent_at
       FROM replies ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    return (stmt.all(...args, clampLimit(q.limit), clampOffset(q.offset)) as unknown as RawReply[]).map((r) => ({
      id: r.id,
      roomId: r.room_id,
      replyTo: r.reply_to,
      text: r.text,
      emotion: r.emotion,
      status: r.status,
      createdAt: r.created_at,
      sentAt: r.sent_at
    }))
  }

  /**
   * 全量导出读取：按过滤条件分页循环读完全部记录（上限 maxRows 防失控）。
   * 结果按时间**升序**返回（导出文件按发生顺序阅读）。
   */
  exportDanmakuRows(q: HistoryQuery = {}, maxRows = 200_000): HistoryDanmaku[] {
    this.flush()
    const out: HistoryDanmaku[] = []
    const pageSize = 5000
    for (let offset = 0; offset < maxRows; offset += pageSize) {
      const { clause, args } = buildFilter(q, ['content', 'nickname'])
      const stmt = this.db.prepare(
        `SELECT id, platform, room_id, type, uid, nickname, content, source, ts
         FROM danmaku ${clause} ORDER BY ts ASC LIMIT ? OFFSET ?`
      )
      const batch = stmt.all(...args, pageSize, offset) as unknown as RawDanmaku[]
      out.push(
        ...batch.map((r) => ({
          id: r.id,
          platform: r.platform as HistoryDanmaku['platform'],
          roomId: r.room_id,
          type: r.type as HistoryDanmaku['type'],
          uid: r.uid,
          nickname: r.nickname,
          content: r.content,
          source: r.source as HistoryDanmaku['source'],
          ts: r.ts
        }))
      )
      if (batch.length < pageSize) break
    }
    return out
  }

  countDanmaku(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM danmaku').get() as { n: number }
    return Number(row.n)
  }

  countReplies(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM replies').get() as { n: number }
    return Number(row.n)
  }

  close(): void {
    this.flush()
    this.db.close()
  }
}

interface RawDanmaku {
  id: string
  platform: string
  room_id: string
  type: string
  uid: string
  nickname: string
  content: string
  source: string
  ts: number
}

interface RawReply {
  id: string
  room_id: string
  reply_to: string
  text: string
  emotion: string
  status: string
  created_at: number
  sent_at: number | null
}
