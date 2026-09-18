import { describe, expect, it } from 'vitest'
import { buildSendScript } from '../src/main/webview/inject/sender'

describe('B 站发送脚本（确认模式对齐五平台）', () => {
  const script = buildSendScript('测试弹幕 半角"引号" 反斜杠\\换行\n')

  it('生成的脚本是合法 JS（编译通过，防模板字符串被反引号提前截断）', () => {
    expect(() => new Function(script)).not.toThrow()
  })

  it('返回 Promise，含 sent / not-confirmed 两条确认结果', () => {
    expect(script).toContain('new Promise')
    expect(script).toContain("resolve('sent')")
    expect(script).toContain("resolve('not-confirmed')")
  })

  it('确认判据：输入框清空或元素消失即视为已发出', () => {
    expect(script).toContain('!document.contains(input)')
    expect(script).toContain('val.indexOf(TEXT) < 0')
  })

  it('嵌入的文本被正确转义（引号与换行）', () => {
    expect(script).toContain('测试弹幕 半角\\"引号\\"')
    expect(script).toContain('换行\\n')
  })

  it('保留游客态/未就绪的同步失败码', () => {
    expect(script).toContain("'need-login'")
    expect(script).toContain("'no-input'")
    expect(script).toContain("'page-not-ready'")
  })
})
