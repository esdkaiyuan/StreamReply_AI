import { describe, expect, it } from 'vitest'
import { DbStore } from '../src/main/db/store'
import type { DanmakuMessage } from '../src/shared/types'

function dm(id: string, roomId: string, nickname: string, content: string, ts: number): DanmakuMessage {
  return {
    id,
    platform: 'bilibili',
    roomId,
    type: 'chat',
    user: { uid: `u-${id}`, nickname },
    content,
    ts,
    source: 'ws'
  }
}

function seed(): DbStore {
  const store = new DbStore(':memory:')
  store.enqueueDanmaku(dm('d1', '1', '小明', '你好呀主播', 100))
  store.enqueueDanmaku(dm('d2', '1', '小红', '今天玩什么', 200))
  store.enqueueDanmaku(dm('d3', '2', '小明', '来了', 300))
  store.flush()
  return store
}

describe('db query', () => {
  it('按房间过滤并按时间倒序', () => {
    const store = seed()
    const rows = store.queryDanmaku({ roomId: '1' })
    expect(rows.map((r) => r.id)).toEqual(['d2', 'd1'])
    store.close()
  })

  it('关键词同时匹配昵称与内容', () => {
    const store = seed()
    expect(store.queryDanmaku({ keyword: '小明' }).map((r) => r.id)).toEqual(['d3', 'd1'])
    expect(store.queryDanmaku({ keyword: '玩什么' }).map((r) => r.id)).toEqual(['d2'])
    store.close()
  })

  it('LIKE 通配符被转义，不会匹配全部', () => {
    const store = seed()
    expect(store.queryDanmaku({ keyword: '%' })).toHaveLength(0)
    expect(store.queryDanmaku({ keyword: '_' })).toHaveLength(0)
    store.close()
  })

  it('limit 与 offset 生效', () => {
    const store = seed()
    expect(store.queryDanmaku({ limit: 1 }).map((r) => r.id)).toEqual(['d3'])
    expect(store.queryDanmaku({ limit: 1, offset: 1 }).map((r) => r.id)).toEqual(['d2'])
    store.close()
  })

  it('查询回复记录', () => {
    const store = new DbStore(':memory:')
    store.saveReply({
      id: 'r1',
      roomId: '1',
      replyTo: '小明',
      text: '你好呀',
      emotion: 'greet',
      priority: 'normal',
      status: 'sent',
      createdAt: 10,
      sentAt: 20
    })
    const rows = store.queryReplies({ roomId: '1' })
    expect(rows).toHaveLength(1)
    expect(rows[0].text).toBe('你好呀')
    expect(rows[0].sentAt).toBe(20)
    expect(store.queryReplies({ keyword: '不存在的词' })).toHaveLength(0)
    store.close()
  })

  it('flush 后新写入的弹幕也能被查询到', () => {
    const store = seed()
    store.enqueueDanmaku(dm('d4', '1', '小刚', '再来一条', 400))
    store.flush()
    expect(store.queryDanmaku({ roomId: '1' })[0].id).toBe('d4')
    store.close()
  })
})
