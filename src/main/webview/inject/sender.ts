const U2028 = new RegExp(String.fromCharCode(0x2028), 'g')
const U2029 = new RegExp(String.fromCharCode(0x2029), 'g')

/** 文本经 JSON.stringify 安全嵌入；额外转义 U+2028/2029 防止旧版解析器把字符串截断 */
function embedText(text: string): string {
  return JSON.stringify(text).replace(U2028, '\\u2028').replace(U2029, '\\u2029')
}

/**
 * B 站页面内「模拟输入 + 发送」脚本。
 *
 * 选择器策略：**先精确候选，再语义扫描**——B 站前端改版频繁，
 * 写死类名会随时失效；语义兜底（contenteditable / placeholder / 父容器类名）更耐久。
 *
 * 关键：必须区分两种失败，否则用户无法自助解决
 * - `need-login`：页面处于游客态（B 站不渲染输入框），需登录
 * - `no-input`：已登录但没找到输入框（改版或非直播间页）
 *
 * 返回 Promise（与其他四平台的 sendSimulator 确认模式对齐）：
 * 点击发送后轮询「输入框是否被清空」——B 站发送成功会清空输入框，
 * 清空即 resolve('sent')，超时 resolve('not-confirmed')，消除「返回 queued 即算成功」的假阳性。
 */
export function buildSendScript(text: string): string {
  return String.raw`(function () {
  var TEXT = ${embedText(text)}
  var EXPLICIT = [
    '.chat-input',
    'textarea.chat-input',
    'input.chat-input',
    '.chat-input textarea',
    '.chat-input__input',
    '[class*="chat-input"] textarea',
    '[class*="chat-input"] [contenteditable="true"]'
  ]
  var KEY_RE = /danmu|danmaku|barrage|chat|comment|say|input|editor/i

  function visible(el) {
    if (!el || el.disabled || el.readOnly) return false
    var r = el.getBoundingClientRect()
    return r.width > 8 && r.height > 8
  }

  function looksLikeChatInput(el) {
    var sig = String(el.className || '') + ' ' + String(el.getAttribute('placeholder') || '') +
      ' ' + String(el.getAttribute('data-placeholder') || '') + ' ' + String(el.getAttribute('aria-label') || '')
    if (KEY_RE.test(sig)) return true
    var p = el.parentElement
    for (var d = 0; d < 3 && p; d++, p = p.parentElement) {
      if (KEY_RE.test(String(p.className || '') + ' ' + String(p.id || ''))) return true
    }
    return false
  }

  function findInput() {
    for (var i = 0; i < EXPLICIT.length; i++) {
      var el = document.querySelector(EXPLICIT[i])
      if (el && visible(el)) return el
    }
    var cands = document.querySelectorAll(
      'textarea, input[type="text"], input:not([type]), [contenteditable="true"]'
    )
    for (var j = 0; j < cands.length; j++) {
      if (!visible(cands[j])) continue
      if (looksLikeChatInput(cands[j])) return cands[j]
    }
    // 刻意不返回「任意可见输入框」：那可能是搜索框，
    // 把 AI 回复打进去并提交是严重错误，宁可如实报 no-input
    return null
  }

  var input = findInput()
  if (!input) {
    var bodyText = document.body ? String(document.body.innerText || '') : ''
    // 页面空白 → 还没加载出来，不要误导用户「去登录」
    if (bodyText.replace(/\s/g, '').length < 40) return 'page-not-ready'
    // 游客态页面根本不渲染输入框，且通常会提示「请先登录」
    if (/(游客|请先登录|登录后|立即登录)/.test(bodyText.slice(0, 6000))) return 'need-login'
    return 'no-input'
  }

  try { input.focus() } catch (e) {}
  var filled = false
  try {
    if (input.isContentEditable) {
      input.textContent = TEXT
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: TEXT, inputType: 'insertText' }))
      filled = true
    } else {
      var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      var desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) {
        desc.set.call(input, '')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        desc.set.call(input, TEXT)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        filled = true
      }
    }
  } catch (e) {}
  if (!filled) return 'no-setter'

  function findButton() {
    var sel = ['.bottom-actions .bl-button', '.chat-control-panel .bl-button', '.bl-button--primary', '[class*="send"] button', 'button[class*="send"]']
    for (var i = 0; i < sel.length; i++) {
      var b = document.querySelector(sel[i])
      if (b) return b
    }
    var all = document.querySelectorAll('button, .bl-button, [role="button"]')
    for (var j = 0; j < all.length; j++) {
      var t = String(all[j].textContent || '').trim()
      if (/^(发送|send)$/i.test(t)) return all[j]
    }
    return null
  }

  // 确认模式：点击发送后轮询「输入框是否被清空」（B 站发送成功会清空），
  // 清空或元素消失（部分改版发送后重建 DOM）即视为已发出；20 次 x 250ms ≈ 5 秒超时。
  return new Promise(function (resolve) {
    setTimeout(function () {
      var btn = findButton()
      try {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
        }))
      } catch (e) {}
      if (btn) { try { btn.click() } catch (e) {} }

      var tries = 0
      var timer = setInterval(function () {
        tries++
        var val = ''
        try {
          val = input.isContentEditable ? String(input.textContent || '') : String(input.value || '')
        } catch (e) { val = '' }
        if (!document.contains(input) || val.indexOf(TEXT) < 0) {
          clearInterval(timer)
          resolve('sent')
          return
        }
        if (tries >= 20) {
          clearInterval(timer)
          resolve('not-confirmed')
        }
      }, 250)
    }, 200 + Math.floor(Math.random() * 400))
  })
})()`
}
