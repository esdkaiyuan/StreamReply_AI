const U2028 = new RegExp(String.fromCharCode(0x2028), 'g')
const U2029 = new RegExp(String.fromCharCode(0x2029), 'g')

/** 文本经 JSON.stringify 安全嵌入；额外转义 U+2028/2029 防止解析器把字符串截断 */
function embed(text: string): string {
  return JSON.stringify(text).replace(U2028, '\\u2028').replace(U2029, '\\u2029')
}

/**
 * 通用「页面内模拟输入并发送」脚本构造器。
 *
 * 抖音与快手的输入框都可能是 `contenteditable` div，也可能是 textarea，
 * 因此按候选选择器依次尝试，最后用回车提交，回车不可用再退回点击发送按钮。
 *
 * ⚠️ 选择器需真实直播间联调确认；全部未命中时返回 'no-input'，
 * 交由调度器计入熔断，绝不静默假装发送成功。
 */
export function buildSimulatedSendScript(
  text: string,
  inputSelectors: string[],
  buttonSelectors: string[]
): string {
  return String.raw`(function () {
  var TEXT = ${embed(text)}
  var INPUT_SELECTORS = ${JSON.stringify(inputSelectors)}
  var BTN_SELECTORS = ${JSON.stringify(buttonSelectors)}

  var input = null
  for (var i = 0; i < INPUT_SELECTORS.length; i++) {
    var el = document.querySelector(INPUT_SELECTORS[i])
    if (el) { input = el; break }
  }
  if (!input) return 'no-input'

  try { input.focus() } catch (e) {}

  if (input.isContentEditable) {
    input.textContent = TEXT
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: TEXT, inputType: 'insertText' }))
  } else {
    var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    var desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (!desc || !desc.set) return 'no-setter'
    desc.set.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    desc.set.call(input, TEXT)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  setTimeout(function () {
    var sentByKey = false
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
      }))
      sentByKey = true
    } catch (e) {}
    if (!sentByKey) {
      for (var j = 0; j < BTN_SELECTORS.length; j++) {
        var btn = document.querySelector(BTN_SELECTORS[j])
        if (btn) { btn.click(); break }
      }
    }
    window.postMessage({ __LDA__: sentByKey ? 'send-done' : 'send-fallback' }, '*')
  }, 200 + Math.floor(Math.random() * 400))

  return 'queued'
})()`
}
