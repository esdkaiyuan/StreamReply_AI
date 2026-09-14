/**
 * 抖音直播 IM 帧抓取（注入到页面主世界）。
 *
 * 与 B 站不同：抖音的弹幕帧是 protobuf，且通道可能是 WebSocket，
 * 也可能是 /webcast/im/fetch 的流式 HTTP 响应，所以三条通道一起挂。
 * 只做「旁路观察」，不改变页面自身行为，也不碰签名逻辑（浏览器已完成签名）。
 *
 * 安全：`ev.source !== window` 丢弃、单帧 ≤4MB、每批 ≤64 帧。
 */
export const DOUYIN_HOOK_SCRIPT = String.raw`(function () {
  if (window.__LDA_DY__) return 'already'
  window.__LDA_DY__ = true

  var WS_MARK = /webcast/i
  var IM_PATH = /\/webcast\/im\//i
  var MAX_FRAME = 4 * 1024 * 1024

  function post(type, buf) {
    try {
      if (!buf || !buf.byteLength || buf.byteLength > MAX_FRAME) return
      window.postMessage({ __LDA__: type, buf: buf }, '*', [buf])
    } catch (e) { /* 结构化克隆失败按帧丢弃 */ }
  }

  function toBytes(view) {
    if (!view) return null
    if (view instanceof ArrayBuffer) return view
    if (ArrayBuffer.isView(view)) return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
    return null
  }

  function hookWs() {
    var Orig = window.WebSocket
    if (!Orig || Orig.__ldaHooked) return
    function Patched(url, protocols) {
      var ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols)
      try {
        if (WS_MARK.test(String(url)) || IM_PATH.test(String(url))) {
          window.postMessage({ __LDA__: 'ws-meta', url: String(url) }, '*')
          ws.addEventListener('message', function (ev) {
            var buf = toBytes(ev.data)
            if (buf) post('dy-frame', buf)
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
  }

  function readStream(res) {
    try {
      if (!res || !res.body || typeof res.clone !== 'function') return
      var reader = res.clone().body.getReader()
      var chunks = []
      var total = 0
      function pump() {
        reader.read().then(function (r) {
          if (r.done) {
            if (total > 0) post('dy-body', concat(chunks, total))
            return
          }
          var v = r.value
          if (v && v.byteLength) {
            chunks.push(v)
            total += v.byteLength
            // 单条 HTTP 响应累计上限 16MB，超限丢弃避免内存膨胀
            if (total > 16 * 1024 * 1024) { try { reader.cancel() } catch (e) {} return }
          }
          pump()
        }).catch(function () { /* 流中断忽略 */ })
      }
      pump()
    } catch (e) { /* 忽略 */ }
  }

  function concat(chunks, total) {
    var out = new Uint8Array(total)
    var off = 0
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].byteLength }
    return out.buffer
  }

  function hookFetch() {
    var orig = window.fetch
    if (typeof orig !== 'function' || orig.__ldaHooked) return
    function patched() {
      var args = arguments
      return orig.apply(this, args).then(function (res) {
        try {
          var url = String((res && res.url) || (args[0] && (args[0].url || args[0])) || '')
          if (IM_PATH.test(url)) readStream(res)
        } catch (e) { /* 忽略 */ }
        return res
      })
    }
    patched.__ldaHooked = true
    window.fetch = patched
  }

  function hookXhr() {
    var Orig = window.XMLHttpRequest
    if (!Orig || Orig.__ldaHooked) return
    var open = Orig.prototype.open
    var send = Orig.prototype.send
    Orig.prototype.open = function (method, url) {
      try { this.__ldaUrl = String(url) } catch (e) {}
      return open.apply(this, arguments)
    }
    Orig.prototype.send = function () {
      try {
        var self = this
        if (IM_PATH.test(self.__ldaUrl || '')) {
          self.addEventListener('load', function () {
            try {
              if (self.responseType === 'arraybuffer') post('dy-body', self.response)
              else if (!self.responseType || self.responseType === 'text') {
                var s = self.responseText
                if (s) post('dy-body', new TextEncoder().encode(s).buffer)
              }
            } catch (e) {}
          })
        }
      } catch (e) {}
      return send.apply(this, arguments)
    }
    Orig.__ldaHooked = true
  }

  hookWs()
  hookFetch()
  hookXhr()
  return 'installed'
})()`
