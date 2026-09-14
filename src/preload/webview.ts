import { contextBridge, ipcRenderer } from 'electron'
import { FRAME_CHANNELS, IPC } from '../shared/types'

// 主世界 → preload → 主进程（弹幕帧 / WS 元信息 / 注入就绪 / DOM 兜底消息）
window.addEventListener('message', (ev) => {
  if (ev.source !== window) return // 仅接受本 frame 注入脚本的消息，隔离页面内 iframe/第三方脚本
  const d = ev.data as {
    __LDA__?: string
    buf?: ArrayBuffer
    url?: string
    messages?: Array<{ nickname: string; content: string }>
  } | null
  if (!d || typeof d !== 'object' || !d.__LDA__) return

  // 抓取通道统一查表：新增平台只改 shared/types.ts 里的 FRAME_CHANNELS
  const route = FRAME_CHANNELS[d.__LDA__]
  if (route) {
    if (!(d.buf instanceof ArrayBuffer)) return
    if (d.buf.byteLength > route.maxBytes) return // 超限帧直接丢弃，防海量字节涌入 IPC
    ipcRenderer.send(route.channel, new Uint8Array(d.buf))
    return
  }

  if (d.__LDA__ === 'ws-meta') {
    ipcRenderer.send(IPC.wvWsMeta, d.url ?? '')
  } else if (d.__LDA__ === 'ws-hook-installed') {
    ipcRenderer.send(IPC.wvInjectReady)
  } else if (d.__LDA__ === 'dom-ready') {
    ipcRenderer.send(IPC.wvDomReady)
  } else if (d.__LDA__ === 'dom-messages' && Array.isArray(d.messages)) {
    ipcRenderer.send(IPC.wvDomMessages, d.messages)
  }
})

// 主进程 → preload → 主世界（发送文本指令；当前发送走 executeJavaScript，此桥为备用路径）
contextBridge.exposeInMainWorld('__ldaWv', {
  onSendText: (cb: (text: string) => void): void => {
    ipcRenderer.on(IPC.wvSendText, (_e, text: string) => {
      window.postMessage({ __LDA__: 'do-send', text }, '*')
    })
  }
})
