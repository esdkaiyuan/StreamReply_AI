/**
 * 「纯视频模式」注入脚本。
 *
 * 目标：把直播间页面裁成**只剩播放器**，并让画面按原比例铺满整块区域。
 *
 * 做法：
 * 1. 从 `<video>` 向上找到播放器容器，得出「祖先链」；
 * 2. 把 `body` 下不在链上的顶层区块全部隐藏（顶栏/侧栏/聊天区/礼物栏等）；
 * 3. 链上每级强制铺满视口；
 * 4. **`object-fit: contain`** —— 保证画面保持原始宽高比（多余部分留黑边，不拉伸不变形）。
 *
 * 不用移动 DOM 节点：搬节点容易让页面自身框架（Vue/React）状态错乱，
 * 纯样式方案足够，且随时可逆。
 */

const STYLE_ID = 'lda-video-mode-style'
const HIDDEN_FLAG = 'data-lda-video-hidden'

/** 承载播放器的 iframe（B 站用 live.bilibili.com/blanc/<room>?liteVersion=true） */
export const PLAYER_FRAME_RE = /blanc|player|liteVersion/i

const CSS = `
html, body {
  margin: 0 !important; padding: 0 !important; height: 100% !important;
  /* B 站页面自带 min-width（约 1280px），会把内部的 iframe/video 撑出视口，必须归零 */
  width: 100% !important; min-width: 0 !important; max-width: 100% !important;
  overflow: hidden !important; background: #000 !important;
}
video {
  width: 100% !important; height: 100% !important;
  max-width: none !important; max-height: none !important;
  /* 关键：保持原始宽高比，多余部分留黑边，不拉伸变形 */
  object-fit: contain !important;
  background: #000 !important;
}
iframe {
  width: 100% !important; height: 100% !important;
  border: 0 !important; display: block !important;
}
`

export const VIDEO_MODE_SCRIPT = String.raw`
(function () {
  if (window.__LDA_VM__ && window.__LDA_VM__.applied) return 'already'

  var STYLE_ID = ${JSON.stringify(STYLE_ID)}
  var HIDDEN_FLAG = ${JSON.stringify(HIDDEN_FLAG)}
  var PLAYER_RE = ${PLAYER_FRAME_RE.toString()}
  var TARGET_RE = /player/i

  /** 顶层文档里没有 <video>（播放器在 iframe 内）时，退而找承载播放器的 iframe */
  function findTarget() {
    var v = document.querySelector('video')
    if (v) return v
    var frames = document.querySelectorAll('iframe')
    for (var i = 0; i < frames.length; i++) {
      var src = String(frames[i].src || '')
      try { if (new RegExp(PLAYER_RE.source, 'i').test(src)) return frames[i] } catch (e) {}
    }
    return null
  }

  function apply() {
    var v = document.querySelector('video')
    var target = findTarget()
    if (!target) return false

    // 找到「播放器容器」：名字像 player 的最近祖先；否则退到 target 的上两层
    var el = target
    for (var i = 0; i < 8 && el && el !== document.body; i++) {
      var sig = String(el.className || '') + ' ' + String(el.id || '')
      if (TARGET_RE.test(sig)) break
      el = el.parentElement
    }
    if (!el || el === document.body) {
      el = (target.parentElement && target.parentElement.parentElement) || target.parentElement
    }
    if (!el) return false

    // 祖先链（不含 body）
    var chain = []
    var n = el
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
      if (chain.indexOf(t) < 0) {
        t.style.setProperty('display', 'none', 'important')
        t.setAttribute(HIDDEN_FLAG, '1')
      }
    }

    // 2) 链上每级铺满
    for (var k = 0; k < chain.length; k++) {
      var e = chain[k]
      e.style.setProperty('display', 'block', 'important')
      e.style.setProperty('width', '100%', 'important')
      e.style.setProperty('height', '100%', 'important')
      e.style.setProperty('max-width', 'none', 'important')
      e.style.setProperty('max-height', 'none', 'important')
      e.style.setProperty('min-width', '0', 'important')
      e.style.setProperty('margin', '0', 'important')
      e.style.setProperty('padding', '0', 'important')
      e.style.setProperty('overflow', 'hidden', 'important')
    }

    // 3) 全局样式（object-fit: contain 保证原比例；iframe 铺满）
    var style = document.getElementById(STYLE_ID)
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      ;(document.head || document.documentElement).appendChild(style)
    }
    style.textContent = ${JSON.stringify(CSS)}

    window.__LDA_VM__ = { applied: true, hasVideo: !!v }
    return true
  }

  window.__LDA_VM__ = { applied: false, hasVideo: false }

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
