/**
 * 主世界 WS Hook：包装 window.WebSocket，识别弹幕服务器连接，
 * 把帧转发到 isolated world（preload）→ 主进程。
 *
 * 实测（2026-09-14，真实直播间）：
 * - 当前网页端弹幕 WS 主机是 `xxx.chat.bilibili.com`，**不再包含 broadcastlv**；
 *   同一主机还会承载 WebRTC 信令（SDP/peers），所以文本帧必须过滤后再转发
 * - 帧可能是 ArrayBuffer / Blob，也可能是 **JSON 字符串**
 * - 部分房间/版本的弹幕连接建立在 blob Worker 内，主世界 hook 看不到
 *   （这类情况由 DOM 兜底脚本接住）
 */
export const WS_HOOK_SCRIPT = String.raw`
(function () {
  if (window.__LDA_HOOKED__) return 'already'
  window.__LDA_HOOKED__ = true
  var NativeWS = window.WebSocket
  // 弹幕主机：chat.bilibili.com（当前）或 broadcastlv（历史/长连接）
  var DANMAKU_RE = /broadcastlv|chat\.bilibili\.com/i
  var enc = new TextEncoder()

  function post(buf) {
    try { window.postMessage({ __LDA__: 'ws-frame', buf: buf }, '*', [buf]) } catch (e) {}
  }

  function fromText(text) {
    // 同一主机也跑 WebRTC 信令，只转发看起来像弹幕事件的 JSON
    if (text.indexOf('"cmd"') < 0) return
    try { post(enc.encode(text).buffer) } catch (e) {}
  }

  function handle(ev) {
    var d = ev.data
    if (typeof d === 'string') fromText(d)
    else if (d instanceof ArrayBuffer) post(d.slice(0))
    else if (typeof Blob !== 'undefined' && d instanceof Blob) {
      d.arrayBuffer().then(function (b) { post(b) }).catch(function () {})
    }
  }

  window.postMessage({ __LDA__: 'ws-hook-installed' }, '*')

  function HookedWebSocket(url, protocols) {
    var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols)
    if (DANMAKU_RE.test(String(url))) {
      window.postMessage({ __LDA__: 'ws-meta', url: String(url) }, '*')
      ws.binaryType = 'arraybuffer'
      ws.addEventListener('message', handle)
    }
    return ws
  }
  HookedWebSocket.prototype = NativeWS.prototype
  HookedWebSocket.CONNECTING = NativeWS.CONNECTING
  HookedWebSocket.OPEN = NativeWS.OPEN
  HookedWebSocket.CLOSING = NativeWS.CLOSING
  HookedWebSocket.CLOSED = NativeWS.CLOSED
  window.WebSocket = HookedWebSocket
  return 'installed'
})()
`
