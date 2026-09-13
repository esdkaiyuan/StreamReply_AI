import { describe, expect, it } from 'vitest'
import { shouldReply } from '../src/main/ai/trigger'
import { ReplyFilter } from '../src/main/sender/filter'
import type { DanmakuMessage, DanmakuType } from '../src/shared/types'

function dm(content: string, type: DanmakuType = 'chat'): DanmakuMessage {
  return {
    id: 'x',
    platform: 'bilibili',
    roomId: '1',
    type,
    user: { uid: 'u', nickname: 'n' },
    content,
    ts: Date.now(),
    source: 'ws'
  }
}

describe('trigger', () => {
  it('smart: chat 与 gift 触发，enter 不触发', () => {
    expect(shouldReply(dm('hi'), 'smart', [])).toBe(true)
    expect(shouldReply(dm('小花花', 'gift'), 'smart', [])).toBe(true)
    expect(shouldReply(dm('', 'enter'), 'smart', [])).toBe(false)
  })
  it('keyword: 仅命中关键词', () => {
    expect(shouldReply(dm('主播多大'), 'keyword', ['多大', '游戏'])).toBe(true)
    expect(shouldReply(dm('今天天气'), 'keyword', ['多大'])).toBe(false)
  })
  it('question: 仅问句', () => {
    expect(shouldReply(dm('你玩什么游戏？'), 'question', [])).toBe(true)
    expect(shouldReply(dm('来了来了'), 'question', [])).toBe(false)
  })
  it('all: 所有 chat 触发', () => {
    expect(shouldReply(dm(''), 'all', [])).toBe(true)
  })
})

describe('filter', () => {
  it('命中敏感词拒绝', () => {
    const f = new ReplyFilter(['赌博', '加微信'])
    expect(f.passesText('来赌博吗')).toBe(false)
    expect(f.passesText('你好呀')).toBe(true)
  })
  it('同内容 10 分钟内去重', () => {
    const f = new ReplyFilter([])
    expect(f.passesText('欢迎欢迎')).toBe(true)
    expect(f.passesText('欢迎欢迎')).toBe(false)
  })
  it('不同内容不受影响', () => {
    const f = new ReplyFilter([])
    f.passesText('A')
    expect(f.passesText('B')).toBe(true)
  })
})
