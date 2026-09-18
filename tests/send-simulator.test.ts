import { describe, expect, it } from 'vitest'
import { buildSimulatedSendScript } from '../src/main/webview/inject/sendSimulator'

const INPUTS = ['[data-e2e="chat-input"]', 'textarea']
const BUTTONS = ['[data-e2e="chat-send"]', 'button[class*="send"]']

describe('sendSimulator 发送脚本（消除假成功收口）', () => {
  const script = buildSimulatedSendScript('测试弹幕 半角"引号" 反斜杠\\换行\n', INPUTS, BUTTONS)

  it('生成的脚本是合法 JS（编译通过，防模板字符串被反引号提前截断）', () => {
    // new Function 仅编译不执行，脚本内 document/window 等在运行期才需要
    expect(() => new Function(script)).not.toThrow()
  })

  it('成功路径返回 Promise，含 sent / not-confirmed 两条确认结果', () => {
    expect(script).toContain('new Promise')
    expect(script).toContain("resolve('sent')")
    expect(script).toContain("resolve('not-confirmed')")
    // 绝不再无条件同步返回 queued —— 那是假成功的根源
    expect(script).not.toMatch(/return\s+'queued'/)
  })

  it('早期失败码仍在同步路径返回（no-input / no-setter / set-failed）', () => {
    expect(script).toContain("return 'no-input'")
    expect(script).toContain("return 'no-setter'")
    expect(script).toContain("return 'set-failed'")
  })

  it('选择器与文本被安全嵌入', () => {
    // 选择器经 JSON.stringify 嵌入，内部双引号被转义为 \"，故断言不含引号的子串
    expect(script).toContain('data-e2e=')
    expect(script).toContain('chat-input')
    expect(script).toContain('chat-send')
    // 文本经 JSON.stringify，换行被转义为 \n 而非裸换行截断脚本
    expect(script).toContain('测试弹幕')
  })
})
