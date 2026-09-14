/**
 * DOM 兜底：MutationObserver 监听直播间弹幕列表，提取「用户名 + 内容」。
 *
 * 为什么需要它：实测当前网页端把弹幕连接建在 **blob Worker** 里，
 * 主世界的 WebSocket hook 看不到；DOM 观察与传输方式无关，是更稳的兜底路径。
 *
 * 选择器策略：**不写死类名**（平台改版频繁），改为按类名/ID 正则扫描候选容器，
 * 取子节点最多、最像「列表」的那个；条目内部再按 name/text 语义找节点，
 * 最后回退到「整条文本按首个冒号拆分」。
 */
export const DOM_OBSERVER_SCRIPT = String.raw`
(function () {
  if (window.__LDA_DOM__) return 'already'
  window.__LDA_DOM__ = true

  var CAND_RE = /danmu|danmaku|barrage|chat|comment|message|reply/i
  var NAME_RE = /user-?name|username|nickname|uname|name/i
  var TEXT_RE = /text|content|message|danmu/i
  var PREFER = ['.danmaku-item-container', '.chat-history-list']

  function findByPrefer() {
    for (var i = 0; i < PREFER.length; i++) {
      var el = document.querySelector(PREFER[i])
      if (el) return el
    }
    return null
  }

  /** 扫描全文档，挑「类名像弹幕容器 且 子节点最多」的元素 */
  function findByScan() {
    var best = null
    var bestScore = 0
    var all = document.querySelectorAll('div,ul,section,aside')
    for (var i = 0; i < all.length; i++) {
      var el = all[i]
      var sig = String(el.className || '') + ' ' + String(el.id || '')
      if (!CAND_RE.test(sig)) continue
      var n = el.children.length
      if (n > bestScore) { bestScore = n; best = el }
    }
    return bestScore >= 1 ? best : null
  }

  function findContainer() {
    return findByPrefer() || findByScan()
  }

  function pickText(el, re) {
    var nodes = el.querySelectorAll('*')
    for (var i = 0; i < nodes.length; i++) {
      if (re.test(String(nodes[i].className || ''))) return nodes[i]
    }
    return null
  }

  function parseItem(item, out) {
    var nameEl = pickText(item, NAME_RE)
    var textEl = pickText(item, TEXT_RE)
    var name = nameEl ? String(nameEl.textContent || '').trim() : ''
    var content = textEl ? String(textEl.textContent || '').trim() : ''
    if (!content) {
      // 兜底：整条文本按首个冒号/冒号拆分（「昵称：内容」是最常见的渲染形态）
      var whole = String(item.textContent || '').replace(/\s+/g, ' ').trim()
      var m = whole.match(/^(.{1,24}?)[：:]\s*(.+)$/)
      if (m) { name = m[1]; content = m[2] } else { content = whole }
    }
    if (!content) return
    if (!name) name = '未知用户'
    // 同一条可能被重复观察到（节点复用），用「昵称+内容」去重
    var key = name + '|' + content
    out._seen = out._seen || {}
    if (out._seen[key]) return
    out._seen[key] = true
    if (Object.keys(out._seen).length > 400) out._seen = {}
    out.push({ nickname: name, content: content })
  }

  function start() {
    var container = findContainer()
    if (!container) { setTimeout(start, 1500); return }
    window.postMessage({ __LDA__: 'dom-ready' }, '*')

    var batch = []
    setInterval(function () {
      if (!batch.length) return
      var payload = batch.splice(0, batch.length)
      window.postMessage({ __LDA__: 'dom-messages', messages: payload }, '*')
    }, 500)

    // 容器内的直接子节点视为一条弹幕；没有子节点的容器则观察其全部后代
    function collect(node) {
      if (!node || node.nodeType !== 1) return
      if (node.parentElement === container) { parseItem(node, batch); return }
      var kids = node.querySelectorAll ? node.querySelectorAll(':scope > *') : []
      Array.prototype.forEach.call(kids, function (k) {
        if (k.parentElement === container) parseItem(k, batch)
      })
    }

    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, collect)
      })
    }).observe(container, { childList: true, subtree: true })
  }

  start()
  return 'dom-observer-started'
})()
`
