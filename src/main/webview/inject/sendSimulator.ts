const U2028 = new RegExp(String.fromCharCode(0x2028), 'g')
const U2029 = new RegExp(String.fromCharCode(0x2029), 'g')

/** 文本经 JSON.stringify 安全嵌入；额外转义 U+2028/2029 防止解析器把字符串截断 */
function embed(text: string): string {
  return JSON.stringify(text).replace(U2028, '\\u2028').replace(U2029, '\\u2029')
}

/**
 * 通用「页面内模拟输入并发送」脚本构造器（抖音 / 快手 / 斗鱼 / 虎牙共用）。
 *
 * 各平台输入框可能是 `contenteditable` div，也可能是 textarea，故按候选选择器依次尝试。
 *
 * 三个关键点（都是踩过的坑）：
 * 1. **contenteditable 必须优先用 `execCommand('insertText')`**：直接改 `textContent`
 *    不会触发 React / Draft 这类富文本编辑器的内部状态 —— 看起来填进去了，实际发出去是空的；
 * 2. **写完后回读校验**：编辑器把文本吃了却返回成功是最难查的故障，
 *    回读为空即判定失败（宁可报错，也不能假装发送成功）；
 * 3. **优先点发送按钮，其次回车**：部分平台不绑 Enter，或只认真实按键。
 *    原实现「回车派发成功就不再点按钮」，导致按钮那条路永远走不到。
 *
 * 【本轮收口 · 消除假成功】旧实现点完发送就同步返回 queued，真实点击发生在其后
 * 200~600ms，系统对「这条弹幕到底有没有发出去」零感知 —— 四平台「发送成功」全是假阳性。
 * 现改为返回一个 Promise：提交后在页面内轮询「输入框是否被清空」（多数平台发送成功后
 * 会即时清空输入框），命中即判 sent；超时仍未清空判 not-confirmed。真实联调若发现某平台
 * 发送后不清空输入框，再在该平台 Sender 里补充「本条文本出现在聊天列表」的确认判据。
 *
 * 失败码：`no-input` / `no-setter` / `set-failed` / `not-confirmed`，由上层映射成可自助解决的说明。
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

  function visible(el) {
    if (!el || el.disabled || el.readOnly) return false
    var r = el.getBoundingClientRect()
    return r.width > 8 && r.height > 8
  }

  function pick(list) {
    var first = null
    for (var i = 0; i < list.length; i++) {
      var el = document.querySelector(list[i])
      if (!el) continue
      if (!first) first = el
      if (visible(el)) return el
    }
    // 候选选择器是按平台精挑的：全都不「可见」时仍取第一个（可能只是尚未完成布局），
    // 由下面的回读校验把关，而不是直接放弃
    return first
  }

  var input = pick(INPUT_SELECTORS)
  if (!input) return 'no-input'

  try { input.focus() } catch (e) {}

  function readBack() {
    if (input.isContentEditable) return String(input.textContent || '')
    return String(input.value || '')
  }

  function fill() {
    if (input.isContentEditable) {
      try {
        input.focus()
        if (document.execCommand && document.execCommand('insertText', false, TEXT)) return true
      } catch (e) { /* 落到 textContent */ }
      input.textContent = TEXT
      try {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: TEXT, inputType: 'insertText' }))
      } catch (e) {
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      return true
    }
    var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    var desc = Object.getOwnPropertyDescriptor(proto, 'value')
    if (!desc || !desc.set) return false
    desc.set.call(input, '')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    desc.set.call(input, TEXT)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }

  if (!fill()) return 'no-setter'

  // 回读校验：文本没进去就如实失败，绝不静默「发送成功」
  var back = readBack().replace(/\s+/g, '')
  if (!back) return 'set-failed'

  function findButton() {
    for (var i = 0; i < BTN_SELECTORS.length; i++) {
      var b = document.querySelector(BTN_SELECTORS[i])
      if (b && !b.disabled) return b
    }
    return null
  }

  // 返回 Promise：真实提交后确认「输入框被清空」才算发出，杜绝假成功
  return new Promise(function (resolve) {
    setTimeout(function () {
      var via = 'none'
      var btn = findButton()
      if (btn) {
        try { btn.click(); via = 'button' } catch (e) { via = 'button-error' }
      }
      if (via !== 'button') {
        try {
          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
          }))
          input.dispatchEvent(new KeyboardEvent('keypress', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
          }))
          via = 'enter'
        } catch (e) { via = 'enter-error' }
      }
      try {
        window.postMessage({ __LDA__: 'send-submit', via: via, len: back.length }, '*')
      } catch (e) {}

      // 提交后轮询确认：输入框被清空即判成功，最多约 4 秒（20 次 x 200ms）
      var tries = 0
      var timer = setInterval(function () {
        tries += 1
        if (!readBack().replace(/\s+/g, '')) {
          clearInterval(timer)
          resolve('sent')
          return
        }
        if (tries >= 20) {
          clearInterval(timer)
          resolve('not-confirmed')
        }
      }, 200)
    }, 200 + Math.floor(Math.random() * 400))
  })
})()`
}
