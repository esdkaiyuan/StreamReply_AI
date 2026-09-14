import Database from 'better-sqlite3'
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

function buildFilter(
  q: HistoryQuery,
  searchFields: string[]
): { clause: string; params: Record<string, unknown> } {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (q.roomId) {
    where.push('room_id = @roomId')
    params['roomId'] = q.roomId
  }
  const kw = q.keyword?.trim()
  if (kw) {
    const parts = searchFields.map((f) => `${f} LIKE @kw ESCAPE '\\'`)
    where.push(`(${parts.join(' OR ')})`)
    params['kw'] = `%${escapeLike(kw)}%`
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

export class DbStore {
  private db: Database.Database
  private buffer: DanmakuMessage[] = []
  private timer: NodeJS.Timeout | null = null
  private stmtInsert: Database.Statement
  private stmtReply: Database.Statement

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
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
    `)
    this.stmtInsert = this.db.prepare(
      `INSERT OR IGNORE INTO danmaku (id, platform, room_id, type, uid, nickname, content, source, ts)
       VALUES (@id, @platform, @roomId, @type, @uid, @nickname, @content, @source, @ts)`
    )
    this.stmtReply = this.db.prepare(
      `INSERT OR REPLACE INTO replies (id, room_id, reply_to, text, emotion, status, created_at, sent_at)
       VALUES (@id, @roomId, @replyTo, @text, @emotion, @status, @createdAt, @sentAt)`
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
    const rows = this.buffer.splice(0, this.buffer.length).map((m) => ({
      id: m.id,
      platform: m.platform,
      roomId: m.roomId,
      type: m.type,
      uid: m.user.uid,
      nickname: m.user.nickname,
      content: m.content,
      source: m.source,
      ts: m.ts
    }))
    const tx = this.db.transaction((list: typeof rows) => {
      for (const r of list) this.stmtInsert.run(r)
    })
    tx(rows)
  }

  saveReply(t: ReplyTask): void {
    this.stmtReply.run({
      id: t.id,
      roomId: t.roomId,
      replyTo: t.replyTo,
      text: t.text,
      emotion: t.emotion,
      status: t.status,
      createdAt: t.createdAt,
      sentAt: t.sentAt ?? null
    })
  }

  queryDanmaku(q: HistoryQuery = {}): HistoryDanmaku[] {
    this.flush() // 先落盘，保证刚捕获的弹幕立刻可查
    const { clause, params } = buildFilter(q, ['content', 'nickname'])
    params['limit'] = clampLimit(q.limit)
    params['offset'] = Math.max(Math.trunc(q.offset ?? 0), 0)
    return this.db
      .prepare(
        `SELECT id, platform, room_id AS roomId, type, uid, nickname, content, source, ts
         FROM danmaku ${clause} ORDER BY ts DESC LIMIT @limit OFFSET @offset`
      )
      .all(params) as HistoryDanmaku[]
  }

  queryReplies(q: HistoryQuery = {}): HistoryReply[] {
    const { clause, params } = buildFilter(q, ['text', 'reply_to'])
    params['limit'] = clampLimit(q.limit)
    params['offset'] = Math.max(Math.trunc(q.offset ?? 0), 0)
    return this.db
      .prepare(
        `SELECT id, room_id AS roomId, reply_to AS replyTo, text, emotion, status,
                created_at AS createdAt, sent_at AS sentAt
         FROM replies ${clause} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`
      )
      .all(params) as HistoryReply[]
  }

  countDanmaku(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM danmaku').get() as { n: number }
    return row.n
  }

  countReplies(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM replies').get() as { n: number }
    return row.n
  }

  close(): void {
    this.flush()
    this.db.close()
  }
}
