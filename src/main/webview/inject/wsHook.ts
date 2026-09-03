/**
 * 主世界 WS Hook：包装 window.WebSocket，识别弹幕服务器连接，
 * 把二进制帧转发到 isolated world（preload）→ 主进程。
 */
export const WS_HOOK_SCRIPT = String.raw`
(function () {
  if (window.__LDA_HOOKED__) return 'already'
  window.__LDA_HOOKED__ = true
  var NativeWS = window.WebSocket
  var DANMAKU_RE = /broadcastlv/i
  function send(buf) {
    try { window.postMessage({ __LDA__: 'ws-frame', buf: buf }, '*', [buf]) } catch (e) {}
  }
  window.postMessage({ __LDA__: 'ws-hook-installed' }, '*')
  function HookedWebSocket(url, protocols) {
    var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols)
    if (DANMAKU_RE.test(String(url))) {
      window.postMessage({ __LDA__: 'ws-meta', url: String(url) }, '*')
      ws.binaryType = 'arraybuffer'
      ws.addEventListener('message', function (ev) {
        if (ev.data instanceof ArrayBuffer) send(ev.data.slice(0))
        else if (ev.data instanceof Blob) ev.data.arrayBuffer().then(send)
      })
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
