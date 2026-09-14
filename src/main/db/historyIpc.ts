import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import type { HistoryDanmaku, HistoryQuery, HistoryReply, HistoryResult } from '../../shared/types'
import type { DbStore } from './store'

/**
 * 历史查询 IPC。db 未就绪（原生模块未重建）时返回 available:false，
 * 让 UI 明确区分「没有记录」与「功能不可用」。
 */
export function registerHistoryIpc(getDb: () => DbStore | null): void {
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
}
