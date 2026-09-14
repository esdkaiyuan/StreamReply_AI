/**
 * 快手直播弹幕抓取（注入到页面主世界）。
 *
 * 快手弹幕走 WebSocket（HTTP 侧看不到相关接口），帧为 protobuf `SocketMessage`。
 * 只做旁路观察：不改写、不拦截，页面自身的 token 握手与心跳完全不受影响。
 */
export const KS_HOOK_SCRIPT = String.raw`(function () {
  if (window.__LDA_KS__) return 'already'
  window.__LDA_KS__ = true

  // 弹幕 WS 主机形如 live-ws-pc.kuaishou.com，同时兼容 kwai 域名
  var WS_MARK = /kuaishou|kwai|live-ws/i
  var MAX_FRAME = 4 * 1024 * 1024

  function toBytes(view) {
    if (!view) return null
    if (view instanceof ArrayBuffer) return view
    if (ArrayBuffer.isView(view)) return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
    return null
  }

  function post(type, buf) {
    try {
      if (!buf || !buf.byteLength || buf.byteLength > MAX_FRAME) return
      window.postMessage({ __LDA__: type, buf: buf }, '*', [buf])
    } catch (e) { /* 结构化克隆失败按帧丢弃 */ }
  }

  var Orig = window.WebSocket
  if (!Orig || Orig.__ldaHooked) return 'skipped'

  function Patched(url, protocols) {
    var ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols)
    try {
      if (WS_MARK.test(String(url))) {
        window.postMessage({ __LDA__: 'ws-meta', url: String(url) }, '*')
        ws.addEventListener('message', function (ev) {
          var buf = toBytes(ev.data)
          if (buf) post('ks-frame', buf)
        })
      }
    } catch (e) { /* 挂载失败不影响页面 */ }
    return ws
  }
  Patched.prototype = Orig.prototype
  Patched.CONNECTING = Orig.CONNECTING
  Patched.OPEN = Orig.OPEN
  Patched.CLOSING = Orig.CLOSING
  Patched.CLOSED = Orig.CLOSED
  Patched.__ldaHooked = true
  window.WebSocket = Patched
  return 'installed'
})()`
