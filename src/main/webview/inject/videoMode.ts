/**
 * 「纯视频模式」注入脚本。
 *
 * 目标：把直播间页面裁成**只剩播放器**，画面按原比例铺满，且不被页面装饰层遮挡。
 *
 * 实测（2026-09-16）B 站结构：
 * ```
 * article#app.tpl-wrap
 *   └ div.rendererRoot → div.layerWrapperRoot → div._pageRoot
 *       └ div.layerWrapperRoot → div.live-non-revenue-player
 *           └ div.live-player-bg          ← 虚化背景层（磨砂的元凶）
 *               └ div.player → div#player-ctnr
 *                   └ iframe(live.bilibili.com/blanc/<room>)  ← 真正的 <video> 在这里
 * ```
 *
 * 三个关键点：
 * 1. **播放器在 iframe 内**，顶层文档查不到 `<video>`；
 * 2. **祖先链里混着装饰层**（虚化背景），把整条链强行铺满会把磨砂层也放大 → 盖住画面；
 *    因此对链上元素**清掉 filter / backdrop-filter / background-image**，
 *    并让播放器 iframe **`position: fixed` 钉在视口最上层**，直接压掉所有装饰层；
 * 3. 文档里其他带 blur / backdrop / mask / veil 语义的元素一律隐藏。
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
     B 站内部会按像素把播放区压小（实测 84px 给控制条），钉住可避免画面被压小。 */
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
  if (window.__LDA_VM__ && window.__LDA_VM__.applied) return 'already'

  var STYLE_ID = ${JSON.stringify(STYLE_ID)}
  var HIDDEN_FLAG = ${JSON.stringify(HIDDEN_FLAG)}
  var PLAYER_RE = ${PLAYER_FRAME_RE.toString()}
  var TARGET_RE = /player/i

  /** 顶层没有 <video>（播放器在 iframe 内）时，退而找承载播放器的 iframe */
  function findTarget() {
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
    el.style.setProperty('display', 'none', 'important')
    el.setAttribute(HIDDEN_FLAG, '1')
  }

  function apply() {
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

    // 祖先链（不含 body）
    var chain = []
    var n = box
    while (n && n !== document.body) {
      chain.push(n)
      n = n.parentElement
    }

    // 1) 隐藏 body 下不在链上的区块（顶栏/侧栏/聊天/礼物栏…）
    var tops = document.body.children
    for (var j = 0; j < tops.length; j++) {
      var t = tops[j]
      var tag = String(t.tagName || '').toUpperCase()
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'NOSCRIPT') continue
      if (chain.indexOf(t) < 0) hide(t)
    }

    // 2) 链上每级：清掉「磨砂」与定位干扰（关键！否则虚化背景层会盖住画面）
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

    // 3) 沿链逐级隐藏兄弟节点：只留通往播放器的那一条
    //    实测播放器控制条是 #fullscreen-container 内的兄弟块，占走 84px 高，
    //    隐掉后 .player-section 才能长到满高、画面不再被压小。
    for (var si = 0; si + 1 < chain.length; si++) {
      var parent = chain[si + 1]
      var keep = chain[si]
      var kids = parent.children
      for (var ki = 0; ki < kids.length; ki++) {
        var kid = kids[ki]
        if (kid === keep) continue
        var ktag = String(kid.tagName || '').toUpperCase()
        if (ktag === 'SCRIPT' || ktag === 'STYLE' || ktag === 'LINK' || ktag === 'NOSCRIPT') continue
        hide(kid)
      }
    }

    // 4) 隐藏页面里其他带模糊/遮罩语义的装饰层（磨砂遮罩、蒙层等）
    var suspects = document.querySelectorAll(
      '[class*="blur" i],[class*="backdrop" i],[class*="veil" i],[class*="frost" i],[class*="scrim" i],[class*="mask" i]'
    )
    for (var m = 0; m < suspects.length; m++) {
      var s = suspects[m]
      if (s === target || chain.indexOf(s) >= 0) continue
      if (s.contains(target)) continue
      hide(s)
    }

    // 5) video 情况（其他平台）：祖先链铺满，用 object-fit 保比例
    //    iframe 情况已在 CSS 里钉成 fixed 全屏
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

    window.__LDA_VM__ = { applied: true, kind: found.kind }
    return true
  }

  window.__LDA_VM__ = { applied: false, kind: null }

  // 播放器可能晚于脚本就绪，按退避重试
  var tries = 0
  function tick() {
    if (apply()) return
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
