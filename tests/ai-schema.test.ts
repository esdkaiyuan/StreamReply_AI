import { describe, expect, it } from 'vitest'
import { parseReply } from '../src/main/ai/schema'

describe('ai reply schema', () => {
  it('解析合法 reply 输出', () => {
    const r = parseReply(
      JSON.stringify({
        action: 'reply',
        reply_to: '小明',
        text: '你好呀小明！',
        emotion: 'greet',
        priority: 'normal',
        reason: '打招呼'
      })
    )
    expect(r).not.toBeNull()
    expect(r!.action).toBe('reply')
    expect(r!.emotion).toBe('greet')
  })

  it('容忍 ```json 代码块包裹', () => {
    const r = parseReply('```json\n{"action":"ignore","text":"","reason":"无意义"}\n```')
    expect(r!.action).toBe('ignore')
  })

  it('text 超长裁剪到 40 字', () => {
    const r = parseReply(JSON.stringify({ action: 'reply', text: '啊'.repeat(50) }))
    expect(r!.text.length).toBe(40)
  })

  it('缺失可选字段时给默认值', () => {
    const r = parseReply('{"action":"reply","text":"ok"}')
    expect(r!.emotion).toBe('answer')
    expect(r!.priority).toBe('normal')
  })

  it('非法 action / 非 JSON 返回 null', () => {
    expect(parseReply('not json')).toBeNull()
    expect(parseReply('{"action":"destroy"}')).toBeNull()
  })
})
