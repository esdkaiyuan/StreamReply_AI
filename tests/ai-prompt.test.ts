import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/main/ai/prompt'
import type { DanmakuMessage } from '../src/shared/types'

function dm(nickname: string, content: string, over: Partial<DanmakuMessage> = {}): DanmakuMessage {
  return {
    id: Math.random().toString(36).slice(2),
    platform: 'bilibili',
    roomId: '1',
    type: 'chat',
    user: { uid: nickname, nickname },
    content,
    ts: Date.now(),
    source: 'ws',
    ...over
  }
}

describe('prompt builder', () => {
  const persona = '你是一个可爱的二次元主播助手'

  it('system 含人设与输出格式说明', () => {
    const { system } = buildPrompt(persona, [], dm('小明', '主播好'), [])
    expect(system).toContain(persona)
    expect(system).toContain('"action"')
    expect(system).toContain('40')
  })

  it('user 含最近上下文与目标弹幕', () => {
    const history = Array.from({ length: 25 }, (_, i) => dm(`u${i}`, `msg${i}`))
    const { user } = buildPrompt(persona, history, dm('小明', '你玩什么游戏'), [
      { user: '小明', reply: '好的' }
    ])
    expect(user).toContain('msg24')
    expect(user).not.toContain('msg4\n')
    expect(user).toContain('你玩什么游戏')
    expect(user).toContain('已回复过')
  })

  it('礼物弹幕标记感谢意图', () => {
    const { user } = buildPrompt(persona, [], dm('土豪', '', { type: 'gift' }), [])
    expect(user).toContain('礼物')
  })
})
