/**
 * 「纯视频模式」注入脚本。
 *
 * 目标：把直播间页面裁成**只剩播放器**，画面按原比例铺满，且不被任何页面元素遮挡。
 *
 * 实测（2026-09-16）B 站结构：
 * ```
 * article#app.tpl-wrap → rendererRoot → layerWrapperRoot → _pageRoot
 *   → layerWrapperRoot → live-non-revenue-player
 *       → .live-player-bg                 ← 虚化背景层（磨砂元凶）
 *           → .player → #player-ctnr
 *               → iframe(live.bilibili.com/blanc/<room>?liteVersion=true)   ← 真正的 <video> 在这里
 * ```
 *
 * 五个关键点：
 * 1. **播放器在 iframe 内**，顶层文档查不到 `<video>`，两层的文档都要处理；
 * 2. 顶层脚本**自己用 `contentDocument` 钻进同源 iframe**（B 站父页与 blanc 页同为
 *    live.bilibili.com，可读），**不要依赖主进程的一次性帧注入** ——
 *    页面刚加载时 iframe 常处于 `about:blank`，此时注入的脚本会随导航一起被销毁，
 *    而且帧内重试定时器也随之消失，导致 blanc 文档永远保持原样（实测故障根因）；
 * 3. **祖先链里混着装饰层**（虚化背景），整条链强行铺满会把磨砂层也放大 → 盖住画面；
 *    所以链上每级要**清掉 filter / backdrop-filter / background-image**；
 * 4. 只隐藏「链的兄弟」不够 —— blanc 页会另起浮层放主播信息条、关注按钮、重播角标、
 *    底部礼物勋章条，必须**隐藏一切不属于祖先链的元素**；
 * 5. 这些浮层是**播放开始后才动态创建**的，所以必须用 MutationObserver 持续清理，
 *    并保留长期轮询，兜住「播放器重建 / iframe 重新导航」这类样式丢失。
 *
 * 不用移动 DOM 节点：搬 iframe 会导致它重新加载（播放中断），纯样式方案可逆且无副作用。
 */

const STYLE_ID = 'lda-video-mode-style'
const HIDDEN_FLAG = 'data-lda-video-hidden'
const DOC_FLAG = 'data-lda-video-doc'
const PIN_ATTR = 'data-lda-video-pin'
const Z_TOP = '2147483647'

/** 承载播放器的 iframe（B 站用 live.bilibili.com/blanc/<room>?liteVersion=true） */
export const PLAYER_FRAME_RE = /blanc|player|liteVersion/i

/**
 * 「发送弹幕要用到的元素」选择器 —— 输入框 + 发送按钮。
 *
 * 纯视频模式会为它们让路：一旦被 `display:none`，
 * 发送脚本的可见性判断（尺寸需 > 8px）就会失败，功能直接失效。
 * ⚠️ 不能用宽泛的 `input`：B 站顶栏搜索框也是 input，会被误留成画面上的残留遮挡。
 * （保留的元素会被固定在视口最上层的播放器盖住，用户依然只看得到画面。）
 */
const INPUT_KEEP_SELECTOR = [
  // 输入框（与 inject/sender.ts 的 EXPLICIT 同一语义）
  'textarea',
  '[contenteditable="true"]',
  '[class*="chat-input"]',
  '[class*="danmaku-input"]',
  '[placeholder*="弹幕"]',
  // 发送按钮：Enter 键兜底之外还有一条点击路径，别把它藏掉
  '[class*="chat-control"]',
  '[class*="bottom-actions"]',
  '[class*="send-bar"]',
  'button[class*="send"]',
  '.bl-button--primary'
].join(', ')

const CSS = `
html, body {
  margin: 0 !important; padding: 0 !important;
  /* B 站页面自带 min-width（约 1280px），会把内部的 iframe/video 撑出视口，必须归零 */
  width: 100% !important; min-width: 0 !important; max-width: 100% !important;
  height: 100% !important; overflow: hidden !important; background: #000 !important;
}
/* 播放器：钉在视口最上层，页面任何虚化/遮罩层都压不住它 */
[${PIN_ATTR}] {
  position: fixed !important; inset: 0 !important;
  width: 100vw !important; height: 100vh !important;
  max-width: none !important; max-height: none !important;
  z-index: ${Z_TOP} !important;
  border: 0 !important; margin: 0 !important; padding: 0 !important;
}
/* video 保持原始宽高比，多余部分留黑边，绝不拉伸变形 */
[${PIN_ATTR}="video"] { object-fit: contain !important; background: #000 !important; }
`

export const VIDEO_MODE_SCRIPT = String.raw`
(function () {
  var STYLE_ID = ${JSON.stringify(STYLE_ID)}
  var HIDDEN_FLAG = ${JSON.stringify(HIDDEN_FLAG)}
  var DOC_FLAG = ${JSON.stringify(DOC_FLAG)}
  var PIN_ATTR = ${JSON.stringify(PIN_ATTR)}
  var PLAYER_RE = ${PLAYER_FRAME_RE.toString()}
  var INPUT_KEEP = ${JSON.stringify(INPUT_KEEP_SELECTOR)}
  var RESCAN_DELAYS = [600, 1800, 3500, 6000, 10000, 16000, 25000, 40000, 60000]

  var prev = window.__LDA_VM__
  if (prev && prev.pass) {
    prev.pass(true)
    return prev.status || 'already'
  }

  var state = {
    applied: false,
    kind: null,
    status: 'waiting',
    observers: [],
    lastTarget: null,
    lastSub: null,
    timer: null
  }
  window.__LDA_VM__ = state

  /** 同源子文档才可读；跨域返回 null（那种情况只能由主进程按 frame 注入） */
  function safeDoc(frame) {
    try {
      var d = frame.contentDocument
      return d && d.body ? d : null
    } catch (e) { return null }
  }

  function area(el) {
    var r = el.getBoundingClientRect()
    return Math.max(0, r.width) * Math.max(0, r.height)
  }

  /** 取「最可能是主画面」的 video：可见面积最大者（页面里常有隐藏的预加载 video） */
  function pickVideo(doc) {
    var vs = doc.querySelectorAll('video')
    if (!vs.length) return null
    var best = null
    var bestArea = -1
    for (var i = 0; i < vs.length; i++) {
      var a = area(vs[i])
      if (a > bestArea) { bestArea = a; best = vs[i] }
    }
    return best || vs[0]
  }

  function findTarget(doc) {
    var v = pickVideo(doc)
    if (v) return { el: v, kind: 'video' }
    var frames = doc.querySelectorAll('iframe')
    var i
    // 优先挑「内部真的有 video」的 iframe（比猜 URL 可靠）
    for (i = 0; i < frames.length; i++) {
      var d = safeDoc(frames[i])
      if (d && pickVideo(d)) return { el: frames[i], kind: 'iframe', sub: d }
    }
    // 跨域播放器：读不到内部文档，退化为 URL 匹配，交给主进程按 frame 注入
    for (i = 0; i < frames.length; i++) {
      var src = String(frames[i].src || '')
      try {
        if (new RegExp(PLAYER_RE.source, 'i').test(src)) {
          return { el: frames[i], kind: 'iframe', sub: null }
        }
      } catch (e) { /* 忽略非法正则环境 */ }
    }
    return null
  }

  function hide(el) {
    if (el.id === STYLE_ID) return
    if (el.getAttribute(HIDDEN_FLAG) === '1') return
    el.style.setProperty('display', 'none', 'important')
    el.setAttribute(HIDDEN_FLAG, '1')
  }

  /**
   * 元素是否必须保留：播放器本身 / 在祖先链上 / 是播放器的祖先。
   * spareInputs 仅用于顶层文档 —— 那里住着「发送弹幕」用的输入框，
   * 一旦被 display:none，发送脚本的查找就会失败（getBoundingClientRect 变成 0 尺寸）。
   * （保留的元素会被固定在视口的播放器盖住，用户依然只看得到画面。）
   *
   * 注意：必须同时判断 el.matches(INPUT_KEEP)。输入框元素自身不可能是自己的后代，
   * 只查 querySelector 会把输入框本身隐藏掉、而它的祖先却被保留 ——
   * 这正是 2026-09-16「发送功能失效」的根因。
   */
  function keep(el, target, chain, spareInputs) {
    if (el === target) return true
    if (chain.indexOf(el) >= 0) return true
    if (el.contains && el.contains(target)) return true
    if (spareInputs) {
      var selfHit = el.matches && el.matches(INPUT_KEEP)
      var innerHit = el.querySelector && el.querySelector(INPUT_KEEP)
      if (selfHit || innerHit) return true
    }
    return false
  }

  function ensureStyle(doc) {
    var style = doc.getElementById(STYLE_ID)
    if (!style) {
      style = doc.createElement('style')
      style.id = STYLE_ID
      ;(doc.head || doc.documentElement).appendChild(style)
    }
    style.textContent = ${JSON.stringify(CSS)}
  }

  /**
   * 播放器在首帧之后才会创建控制条、礼物/勋章条等浮层，
   * 只扫一次必然漏 —— 持续监听新增节点并清掉。
   */
  function observe(doc, target, chain, spareInputs) {
    for (var i = 0; i < state.observers.length; i++) {
      if (state.observers[i].doc === doc) return
    }
    if (!doc.defaultView || !doc.defaultView.MutationObserver) return
    var obs = new doc.defaultView.MutationObserver(function (muts) {
      for (var m = 0; m < muts.length; m++) {
        var added = muts[m].addedNodes
        for (var j = 0; j < added.length; j++) {
          var node = added[j]
          if (node.nodeType !== 1) continue
          if (node.querySelector && node.querySelector('video, iframe')) continue // 播放器重建，交给复扫
          if (keep(node, target, chain, spareInputs)) continue
          hide(node)
        }
      }
    })
    try {
      obs.observe(doc.body, { childList: true, subtree: true })
      state.observers.push({ doc: doc, obs: obs })
    } catch (e) { /* 观察失败不影响主流程 */ }
  }

  /** 把一个文档裁成「只剩播放器」 */
  function process(doc, target, kind, spareInputs) {
    if (!target || !doc.body) return false
    var win = doc.defaultView
    var chain = []
    var n = target
    while (n && n !== doc.body) { chain.push(n); n = n.parentElement }

    // 1) 链上每级：清掉「磨砂」与定位干扰，并保证自身可见
    for (var k = 0; k < chain.length; k++) {
      var e = chain[k]
      e.style.setProperty('filter', 'none', 'important')
      e.style.setProperty('-webkit-filter', 'none', 'important')
      e.style.setProperty('backdrop-filter', 'none', 'important')
      e.style.setProperty('-webkit-backdrop-filter', 'none', 'important')
      e.style.setProperty('transform', 'none', 'important')
      e.style.setProperty('perspective', 'none', 'important')
      e.style.setProperty('background-image', 'none', 'important')
      e.style.setProperty('background-color', 'transparent', 'important')
      e.style.removeProperty('display')
      if (win && win.getComputedStyle(e).display === 'none') {
        e.style.setProperty('display', 'block', 'important')
      }
    }

    // 2) 只留播放器：隐藏一切不属于祖先链的元素
    var all = doc.querySelectorAll('body *')
    for (var i = 0; i < all.length; i++) {
      var a = all[i]
      if (keep(a, target, chain, spareInputs)) continue
      var t = String(a.tagName || '').toUpperCase()
      if (t === 'SCRIPT' || t === 'STYLE' || t === 'LINK' || t === 'NOSCRIPT') continue
      hide(a)
    }

    // 3) 钉住播放器（CSS 里按属性选择器铺满视口）
    target.setAttribute(PIN_ATTR, kind === 'video' ? 'video' : 'frame')

    ensureStyle(doc)
    observe(doc, target, chain, spareInputs)
    doc.documentElement.setAttribute(DOC_FLAG, '1')
    return true
  }

  /**
   * 一趟处理：本层文档 + 同源播放器 iframe。
   * 返回 false 表示本层还没找到播放器（调用方继续重试）。
   */
  function pass(force) {
    var t = findTarget(document)
    if (!t) return false

    var ownDone = document.documentElement.getAttribute(DOC_FLAG) === '1' && state.lastTarget === t.el
    if (force || !ownDone) process(document, t.el, t.kind, true)
    state.lastTarget = t.el

    var subDone = true
    if (t.kind === 'iframe') {
      var sub = t.sub || safeDoc(t.el)
      if (sub && sub !== document) {
        var sv = pickVideo(sub)
        if (sv) {
          var already = sub.documentElement.getAttribute(DOC_FLAG) === '1' && state.lastSub === sv
          if (force || !already) process(sub, sv, 'video', false)
          state.lastSub = sv
        } else {
          subDone = false // 视频还没创建，下一趟再看
        }
      } else {
        subDone = false // 跨域：本层进不去，靠主进程按 frame 注入
      }
    }

    state.applied = true
    state.kind = t.kind
    state.status = subDone ? 'applied' : 'waiting'
    return true
  }

  state.pass = pass

  function stop() {
    if (state.timer) { clearInterval(state.timer); state.timer = null }
  }
  state.stop = stop

  function tick() {
    if (pass()) {
      // 已就绪后转为低频轮询：兜住播放器重建 / iframe 重新导航导致的样式丢失
      if (!state.timer) state.timer = setInterval(function () { pass(false) }, 3000)
      return
    }
    setTimeout(tick, 700)
  }

  for (var d = 0; d < RESCAN_DELAYS.length; d++) {
    setTimeout(function () { pass(true) }, RESCAN_DELAYS[d])
  }
  tick()
  return state.status
})()
`

export const CLEAR_VIDEO_MODE_SCRIPT = String.raw`
(function () {
  var STYLE_ID = ${JSON.stringify(STYLE_ID)}
  var HIDDEN_FLAG = ${JSON.stringify(HIDDEN_FLAG)}
  var DOC_FLAG = ${JSON.stringify(DOC_FLAG)}
  var PIN_ATTR = ${JSON.stringify(PIN_ATTR)}

  function clean(doc) {
    if (!doc || !doc.body) return
    var style = doc.getElementById(STYLE_ID)
    if (style && style.parentNode) style.parentNode.removeChild(style)
    var hidden = doc.querySelectorAll('[' + HIDDEN_FLAG + ']')
    for (var i = 0; i < hidden.length; i++) {
      hidden[i].style.removeProperty('display')
      hidden[i].removeAttribute(HIDDEN_FLAG)
    }
    var pinned = doc.querySelectorAll('[' + PIN_ATTR + ']')
    for (var j = 0; j < pinned.length; j++) pinned[j].removeAttribute(PIN_ATTR)
    if (doc.documentElement) doc.documentElement.removeAttribute(DOC_FLAG)
  }

  var vm = window.__LDA_VM__
  if (vm) {
    if (vm.stop) vm.stop()
    for (var o = 0; o < (vm.observers || []).length; o++) {
      try { vm.observers[o].obs.disconnect() } catch (e) {}
    }
    vm.observers = []
    vm.pass = null
    vm.applied = false
    vm.status = 'cleared'
  }

  clean(document)
  // 同源播放器 iframe 里的改动也要还原
  var frames = document.querySelectorAll('iframe')
  for (var f = 0; f < frames.length; f++) {
    try { clean(frames[f].contentDocument) } catch (e) { /* 跨域跳过 */ }
  }
  return 'video-mode-cleared'
})()
`
