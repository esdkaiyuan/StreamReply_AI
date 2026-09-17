import { dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { IPC } from '../../shared/types'
import type { HistoryDanmaku, HistoryQuery, HistoryReply, HistoryResult } from '../../shared/types'
import type { DbStore } from './store'

const CSV_HEADER = ['ts', 'platform', 'roomId', 'type', 'uid', 'nickname', 'content', 'source']

function toCsv(rows: HistoryDanmaku[]): string {
  const esc = (v: unknown): string => {
    const s = String(v ?? '')
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [CSV_HEADER.join(',')]
  for (const r of rows) {
    lines.push(
      [r.ts, r.platform, r.roomId, r.type, r.uid, r.nickname, r.content, r.source].map(esc).join(',')
    )
  }
  // UTF-8 BOM：Excel 直接打开不乱码
  return '\ufeff' + lines.join('\r\n')
}

/**
 * 历史查询 IPC。db 未就绪（原生模块未重建）时返回 available:false，
 * 让 UI 明确区分「没有记录」与「功能不可用」。
 */
export function registerHistoryIpc(
  getDb: () => DbStore | null,
  getWin: () => Electron.BrowserWindow | null
): void {
  ipcMain.handle(
    IPC.historyDanmaku,
    (_e, q: HistoryQuery = {}): HistoryResult<HistoryDanmaku> => {
      const db = getDb()
      if (!db) return { available: false, items: [] }
      try {
        return { available: true, items: db.queryDanmaku(q) }
      } catch (err) {
        console.error('[db] query danmaku failed', err)
        return { available: false, items: [] }
      }
    }
  )

  ipcMain.handle(IPC.historyReplies, (_e, q: HistoryQuery = {}): HistoryResult<HistoryReply> => {
    const db = getDb()
    if (!db) return { available: false, items: [] }
    try {
      return { available: true, items: db.queryReplies(q) }
    } catch (err) {
      console.error('[db] query replies failed', err)
      return { available: false, items: [] }
    }
  })

  /** 弹幕导出为本地文件（CSV / JSON），按查询条件过滤 */
  ipcMain.handle(
    IPC.historyExport,
    async (
      _e,
      q: HistoryQuery,
      format: 'csv' | 'json'
    ): Promise<{ ok: boolean; path?: string; count?: number; error?: string }> => {
      try {
        const db = getDb()
        if (!db) return { ok: false, error: '数据库未就绪' }
        const rows = db.exportDanmakuRows(q)
        if (!rows.length) return { ok: false, error: '没有可导出的弹幕记录' }
        const win = getWin()
        const scope = q.roomId ? `房间${q.roomId}` : '全部房间'
        const date = new Date().toISOString().slice(0, 10)
        const ext = format === 'csv' ? 'csv' : 'json'
        const res = await dialog.showSaveDialog(win ?? undefined!, {
          title: '导出弹幕数据',
          defaultPath: `弹幕_${scope}_${date}.${ext}`,
          filters: [{ name: format.toUpperCase(), extensions: [ext] }]
        })
        if (res.canceled || !res.filePath) return { ok: false, error: '已取消' }
        const body = format === 'csv' ? toCsv(rows) : JSON.stringify(rows, null, 1)
        await writeFile(res.filePath, body, 'utf8')
        console.log(`[db] 已导出 ${rows.length} 条弹幕 -> ${res.filePath}`)
        return { ok: true, path: res.filePath, count: rows.length }
      } catch (err) {
        console.error('[db] export failed', err)
        return { ok: false, error: String(err).replace(/^Error:\s*/, '') }
      }
    }
  )
}
