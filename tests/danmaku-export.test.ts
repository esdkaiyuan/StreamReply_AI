import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { DanmakuMessage } from '../src/shared/types'
import { toCsv } from '../src/main/db/csv'
import { DbStore } from '../src/main/db/store'

const dir = mkdtempSync(join(tmpdir(), 'lda-export-'))
const store = new DbStore(join(dir, 'test.db'))

function msg(partial: Partial<DanmakuMessage> & { id: string }): DanmakuMessage {
  return {
    platform: 'bilibili',
    roomId: '123',
    type: 'chat',
    user: { uid: 'u1', nickname: '用户' },
    content: '内容',
    ts: Date.now(),
    source: 'ws',
    ...partial
  }
}

afterAll(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('弹幕导出（本地数据保存）', () => {
  const base = Date.now()
  const rows: Array<[string, string, string, number]> = [
    ['d3', 'C用户', '带,逗号和"引号"的内容', base + 3000],
    ['d1', 'A用户', '第一页', base],
    ['d2', 'B用户', '带\n换行的\r\n内容', base + 1000]
  ]
  it('准备三条测试弹幕', () => {
    for (const [id, nick, content, ts] of rows) {
      store.enqueueDanmaku(msg({ id, user: { uid: 'u', nickname: nick }, content, ts }))
    }
    store.flush()
    expect(store.countDanmaku()).toBeGreaterThanOrEqual(3)
  })

  it('exportDanmakuRows 按时间升序返回全部记录', () => {
    const all = store.exportDanmakuRows({})
    const ids = all.filter((r) => ['d1', 'd2', 'd3'].includes(r.id)).map((r) => r.id)
    expect(ids).toEqual(['d1', 'd2', 'd3']) // 升序
  })

  it('支持按房间过滤', () => {
    store.enqueueDanmaku(msg({ id: 'other-room', roomId: '999', content: '别的房间', ts: base + 5000 }))
    store.flush()
    const only = store.exportDanmakuRows({ roomId: '999' })
    expect(only.length).toBe(1)
    expect(only[0].id).toBe('other-room')
  })

  it('CSV：带 UTF-8 BOM、表头与逗号/引号/换行转义', () => {
    const all = store.exportDanmakuRows({})
    const csv = toCsv(all)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.slice(1).split('\r\n')[0]).toBe('ts,platform,roomId,type,uid,nickname,content,source')
    // 逗号→引号包裹；引号→双写（RFC 4180）
    expect(csv).toContain('"带,逗号和""引号""的内容"')
    // 字段内换行同样用引号包裹保留
    expect(csv).toContain('"带\n换行的\r\n内容"')
  })

  it('超过单页大小时分页读取不丢数据', () => {
    for (let i = 0; i < 120; i += 1) {
      store.enqueueDanmaku(msg({ id: `bulk-${i}`, content: `b${i}`, ts: base + 10_000 + i }))
    }
    store.flush()
    const all = store.exportDanmakuRows({ roomId: '123' })
    const bulk = all.filter((r) => r.id.startsWith('bulk-'))
    expect(bulk.length).toBe(120)
  })
})
