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
 *               → iframe(live.bilibili.com/blanc/<room>)   ← 真正的 <video> 在这里
 * ```
 *
 * 四个关键点：
 * 1. **播放器在 iframe 内**，顶层文档查不到 `<video>`，两层的文档都要处理；
 * 2. **祖先链里混着装饰层**（虚化背景），整条链强行铺满会把磨砂层也放大 → 盖住画面；
 *    所以链上每级要**清掉 filter / backdrop-filter / background-image**；
 * 3. 只隐藏「链的兄弟」不够 —— blanc 页会另起浮层放主播信息条、关注按钮、重播角标、
 *    底部礼物勋章条，必须**隐藏一切不属于祖先链的元素**；
 * 4. 这些浮层是**播放开始后才动态创建**的，所以必须用 MutationObserver 持续清理，
 *    否则首帧之后出现的控制条/礼物条会一直压在画面上。
 *
 * 不用移动 DOM 节点：搬 iframe 会导致它重新加载（播放中断），纯样式方案可逆且无副作用。
 */

const STYLE_ID = 'lda-video-mode-style'
const HIDDEN_FLAG = 'data-lda-video-hidden'
const Z_TOP = '2147483647'

/** 承载播放器的 iframe（B 站用 live.bilibili.com/blanc/<room>?liteVersion=true） */
export const PLAYER_FRAME_RE = /blanc|player|liteVersion/i

const CSS = `
html, body {
  margin: 0 !important; padding: 0 !important; height: 100% !important;
  /* B 站页面自带 min-width（约 1280px），会把内部的 iframe/video 撑出视口，必须归零 */
  width: 100% !important; min-width: 0 !important; max-width: 100% !important;
  overflow: hidden !important; background: #000 !important;
}
/* 播放器 iframe：钉在视口最上层，页面任何虚化/遮罩层都压不住它 */
iframe {
  position: fixed !important; inset: 0 !important;
  width: 100vw !important; height: 100vh !important;
  z-index: ${Z_TOP} !important;
  border: 0 !important; display: block !important;
}
video {
  /* 钉成视口大小：面板本身是 16:9，16:9 的流放进去正好铺满、零黑边。
     B 站内部会按像素把播放区压小（给控制条留位），钉住可避免画面被压小。 */
  position: fixed !important; inset: 0 !important;
  width: 100vw !important; height: 100vh !important;
  z-index: ${Z_TOP} !important;
  max-width: none !important; max-height: none !important;
  /* 保持原始宽高比，多余部分留黑边，不拉伸变形 */
  object-fit: contain !important;
  background: #000 !important;
}
`

export const VIDEO_MODE_SCRIPT = String.raw`
(function () {
  var STYLE_ID = ${JSON.stringify(STYLE_ID)}
  var HIDDEN_FLAG = ${JSON.stringify(HIDDEN_FLAG)}
  var PLAYER_RE = ${PLAYER_FRAME_RE.toString()}
  var TARGET_RE = /player/i

  if (window.__LDA_VM__ && window.__LDA_VM__.pass) {
    window.__LDA_VM__.pass()
    return 'already'
  }
  var state = { applied: false, kind: null, observer: null }
  window.__LDA_VM__ = state

  function findTarget() {
    // 优先复用已经钉住的那个 video，避免质量切换后认错元素
    var pinned = document.querySelector('body > video[style*="position: fixed"]')
    if (pinned) return { el: pinned, kind: 'video' }
    var v = document.querySelector('video')
    if (v) return { el: v, kind: 'video' }
    var frames = document.querySelectorAll('iframe')
    for (var i = 0; i < frames.length; i++) {
      var src = String(frames[i].src || '')
      try { if (new RegExp(PLAYER_RE.source, 'i').test(src)) return { el: frames[i], kind: 'iframe' } } catch (e) {}
    }
    return null
  }

  function hide(el) {
    if (el.id === STYLE_ID) return
    if (el.getAttribute(HIDDEN_FLAG) === '1') return
    el.style.setProperty('display', 'none', 'important')
    el.setAttribute(HIDDEN_FLAG, '1')
  }

  /** 元素是否必须保留：就是播放器本身 / 在祖先链上 / 是播放器的祖先 */
  function keep(el, target, chain) {
    if (el === target) return true
    if (chain.indexOf(el) >= 0) return true
    if (el.contains && el.contains(target)) return true
    return false
  }

  /** 含 video/iframe 的子树一律不动：可能是播放器重建（切画质），动它会黑屏 */
  function hasMedia(el) {
    return !!(el.querySelector && el.querySelector('video, iframe'))
  }

  function pass() {
    var found = findTarget()
    if (!found) return false
    var target = found.el

    // 播放器容器：名字像 player 的最近祖先；否则退到 target 的上两层
    var box = target
    for (var i = 0; i < 8 && box && box !== document.body; i++) {
      var sig = String(box.className || '') + ' ' + String(box.id || '')
      if (TARGET_RE.test(sig)) break
      box = box.parentElement
    }
    if (!box || box === document.body) {
      box = (target.parentElement && target.parentElement.parentElement) || target.parentElement
    }
    if (!box) return false

    var chain = []
    var n = box
    while (n && n !== document.body) {
      chain.push(n)
      n = n.parentElement
    }

    // 1) 链上每级：清掉「磨砂」与定位干扰
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
      if (getComputedStyle(e).display === 'none') {
        e.style.setProperty('display', 'block', 'important')
      }
    }

    // 2) 只留播放器：隐藏一切不属于祖先链的元素
    var all = document.querySelectorAll('body *')
    for (var ai = 0; ai < all.length; ai++) {
      var a = all[ai]
      if (keep(a, target, chain)) continue
      hide(a)
    }

    // 3) video 情况（其他平台）：祖先链铺满，用 object-fit 保比例；iframe 情况已在 CSS 里钉成全屏
    if (found.kind === 'video') {
      for (var q = 0; q < chain.length; q++) {
        var c = chain[q]
        c.style.setProperty('width', '100%', 'important')
        c.style.setProperty('height', '100%', 'important')
        c.style.setProperty('max-width', 'none', 'important')
        c.style.setProperty('max-height', 'none', 'important')
        c.style.setProperty('min-width', '0', 'important')
        c.style.setProperty('margin', '0', 'important')
        c.style.setProperty('padding', '0', 'important')
        c.style.setProperty('overflow', 'hidden', 'important')
      }
    }

    var style = document.getElementById(STYLE_ID)
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      ;(document.head || document.documentElement).appendChild(style)
    }
    style.textContent = ${JSON.stringify(CSS)}

    state.applied = true
    state.kind = found.kind
    installObserver(target, chain)
    return true
  }

  /**
   * 播放器在首帧之后才会创建控制条、礼物/勋章条等浮层，
   * 只扫一次必然漏 —— 持续监听新增节点并清掉，同时在若干时间点整树复扫。
   */
  function installObserver(target, chain) {
    if (!state.observer && window.MutationObserver) {
      state.observer = new MutationObserver(function (muts) {
        var t = findTarget()
        if (!t) return
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes
          for (var j = 0; j < added.length; j++) {
            var node = added[j]
            if (node.nodeType !== 1) continue
            if (hasMedia(node)) continue // 播放器重建，交给复扫处理
            if (keep(node, t.el, chain)) continue
            hide(node)
          }
        }
      })
      try {
        state.observer.observe(document.body, { childList: true, subtree: true })
      } catch (e) { /* 观察失败不影响主流程 */ }
    }
    var delays = [800, 2500, 5000, 9000, 15000, 25000]
    for (var d = 0; d < delays.length; d++) setTimeout(function () { pass() }, delays[d])
  }

  state.pass = pass
  var tries = 0
  function tick() {
    if (pass()) return
    tries += 1
    if (tries < 25) setTimeout(tick, 800)
  }
  tick()
  return 'video-mode-injected'
})()
`

export const CLEAR_VIDEO_MODE_SCRIPT = String.raw`
(function () {
  var STYLE_ID = ${JSON.stringify(STYLE_ID)}
  var HIDDEN_FLAG = ${JSON.stringify(HIDDEN_FLAG)}
  if (window.__LDA_VM__ && window.__LDA_VM__.observer) {
    try { window.__LDA_VM__.observer.disconnect() } catch (e) {}
    window.__LDA_VM__.observer = null
  }
  if (window.__LDA_VM__) window.__LDA_VM__.pass = null
  var style = document.getElementById(STYLE_ID)
  if (style && style.parentNode) style.parentNode.removeChild(style)
  var hidden = document.querySelectorAll('[' + HIDDEN_FLAG + ']')
  for (var i = 0; i < hidden.length; i++) {
    hidden[i].style.removeProperty('display')
    hidden[i].removeAttribute(HIDDEN_FLAG)
  }
  if (window.__LDA_VM__) window.__LDA_VM__.applied = false
  return 'video-mode-cleared'
})()
`
