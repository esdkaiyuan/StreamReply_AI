const U2028 = new RegExp(String.fromCharCode(0x2028), 'g')
const U2029 = new RegExp(String.fromCharCode(0x2029), 'g')

function embedText(text: string): string {
  return JSON.stringify(text).replace(U2028, '\\u2028').replace(U2029, '\\u2029')
}

/**
 * 抖音直播间的弹幕输入框在未聚焦时不挂载，这里按候选选择器依次尝试，
 * 兼容 `contenteditable` div 与 textarea 两种形态，最后用回车提交。
 *
 * ⚠️ 选择器与提交流程需在真实直播间联调确认（本项目无可用的登录态环境）。
 * 全部候选失败时返回 'no-input'，交由调度器计入熔断。
 */
export function buildDouyinSendScript(text: string): string {
  return String.raw`(function () {
  var TEXT = ${embedText(text)}
  var INPUT_SELECTORS = [
    '.webcast-chatroom___input',
    '[class*="chatroom"][class*="input"]',
    'div[contenteditable="true"]',
    'textarea[class*="input"]',
    '.semi-input',
    'input[class*="input"]'
  ]
  var input = null
  for (var i = 0; i < INPUT_SELECTORS.length; i++) {
    var el = document.querySelector(INPUT_SELECTORS[i])
    if (el) { input = el; break }
  }
  if (!input) return 'no-input'

  input.focus()

  if (input.isContentEditable) {
    input.textContent = TEXT
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: TEXT, inputType: 'insertText' }))
  } else {
    var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    var setter = Object.getOwnPropertyDescriptor(proto, 'value')
    if (!setter || !setter.set) return 'no-setter'
    setter.set.call(input, TEXT)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  setTimeout(function () {
    var ok = false
    try {
      ok = input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
      }))
    } catch (e) {}
    // 部分构建版本不响应合成事件，退回点击发送按钮
    var BTN = document.querySelector('[class*="send"] button') || document.querySelector('button[class*="send"]')
    if (BTN) BTN.click()
    window.postMessage({ __LDA__: ok ? 'send-done' : 'send-fallback' }, '*')
  }, 200 + Math.floor(Math.random() * 400))

  return 'queued'
})()`
}
