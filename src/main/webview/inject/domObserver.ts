/**
 * DOM 兜底：MutationObserver 监听 B 站网页端弹幕列表，提取 用户名+内容。
 * 仅 chat 类型；id 由 roomId+ts+内容哈希合成（规格第 4 节兜底规则）。
 */
export const DOM_OBSERVER_SCRIPT = String.raw`
(function () {
  if (window.__LDA_DOM__) return 'already'
  window.__LDA_DOM__ = true
  var CONTAINER_SELS = ['.danmaku-item-container', '.chat-history-list', '[class*=danmaku-item-container]']
  var ITEM_SELS = ['.danmaku-item', '[class*=danmaku-item]']
  var NAME_SELS = ['.danmaku-item-user-name', '[class*=user-name]']
  var TEXT_SELS = ['.danmaku-item-text', '[class*=danmaku-item-text]']

  function findContainer() {
    for (var i = 0; i < CONTAINER_SELS.length; i++) {
      var el = document.querySelector(CONTAINER_SELS[i])
      if (el) return el
    }
    return null
  }

  function parseItem(item, out) {
    var nameEl = item.querySelector(NAME_SELS.join(','))
    var textEl = item.querySelector(TEXT_SELS.join(','))
    if (!textEl) return
    var name = nameEl ? nameEl.textContent.trim() : '未知用户'
    var content = textEl.textContent.trim()
    if (!content) return
    var key = name + '|' + content
    if (out._seen && out._seen[key]) return
    out.push({ nickname: name, content: content })
    out._seen = out._seen || {}
    out._seen[key] = true
  }

  function start() {
    var container = findContainer()
    if (!container) { setTimeout(start, 1000); return }
    window.postMessage({ __LDA__: 'dom-ready' }, '*')
    var batch = []
    setInterval(function () {
      if (!batch.length) return
      var payload = batch.splice(0, batch.length)
      window.postMessage({ __LDA__: 'dom-messages', messages: payload }, '*')
    }, 500)
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1) return
          if (n.matches(ITEM_SELS.join(','))) parseItem(n, batch)
          else if (n.querySelectorAll) {
            n.querySelectorAll(ITEM_SELS.join(',')).forEach(function (it) { parseItem(it, batch) })
          }
        })
      })
    }).observe(container, { childList: true, subtree: true })
  }
  start()
  return 'dom-observer-started'
})()
`
