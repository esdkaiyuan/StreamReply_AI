/** 弹幕导出的 CSV 序列化（含 UTF-8 BOM，Excel 直接打开不乱码） */
import type { HistoryDanmaku } from '../../shared/types'

const CSV_HEADER = ['ts', 'platform', 'roomId', 'type', 'uid', 'nickname', 'content', 'source']

export function toCsv(rows: HistoryDanmaku[]): string {
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
  return '\ufeff' + lines.join('\r\n')
}
