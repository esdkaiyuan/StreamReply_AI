const U2028 = new RegExp(String.fromCharCode(0x2028), 'g')
const U2029 = new RegExp(String.fromCharCode(0x2029), 'g')

/** 文本经 JSON.stringify 安全嵌入；额外转义 U+2028/2029 防止旧版解析器把字符串截断 */
function embedText(text: string): string {
  return JSON.stringify(text).replace(U2028, '\\u2028').replace(U2029, '\\u2029')
}

/** 在页面主世界模拟输入 + 点击发送（带用户登录态，行为与真人一致） */
export function buildSendScript(text: string): string {
  return String.raw`(function () {
  var TEXT = ${embedText(text)}
  var INPUT_SELECTORS = ['.chat-input', 'textarea.chat-input', 'input.chat-input', '.chat-input textarea']
  var input = null
  for (var i = 0; i < INPUT_SELECTORS.length; i++) {
    var el = document.querySelector(INPUT_SELECTORS[i])
    if (el) { input = el; break }
  }
  if (!input) return 'no-input'
  var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  if (!setter) return 'no-setter'
  input.focus()
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  setter.call(input, TEXT)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  setTimeout(function () {
    var BTN_SELECTORS = ['.bottom-actions .bl-button', '.chat-control-panel .bl-button', '.bl-button--primary']
    for (var j = 0; j < BTN_SELECTORS.length; j++) {
      var btn = document.querySelector(BTN_SELECTORS[j])
      if (btn) {
        btn.click()
        window.postMessage({ __LDA__: 'send-done' }, '*')
        return
      }
    }
    window.postMessage({ __LDA__: 'send-failed' }, '*')
  }, 200 + Math.floor(Math.random() * 400))
  return 'queued'
})()`
}
