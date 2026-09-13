import { describe, expect, it } from 'vitest'
import { DbStore } from '../src/main/db/store'

describe('db store', () => {
  it('内存库批量写入与回复写入', () => {
    const store = new DbStore(':memory:')
    store.enqueueDanmaku({
      id: 'd1',
      platform: 'bilibili',
      roomId: '1',
      type: 'chat',
      user: { uid: 'u1', nickname: '小明' },
      content: '你好',
      ts: 1,
      source: 'ws'
    })
    store.flush()
    store.saveReply({
      id: 'r1',
      roomId: '1',
      replyTo: '小明',
      text: '你好呀',
      emotion: 'greet',
      priority: 'normal',
      status: 'sent',
      createdAt: 2,
      sentAt: 3
    })
    expect(store.countDanmaku()).toBe(1)
    expect(store.countReplies()).toBe(1)
    store.close()
  })
})
