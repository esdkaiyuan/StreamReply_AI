import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'

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
  if (d.__LDA__ === 'ws-frame' && d.buf instanceof ArrayBuffer) {
    if (d.buf.byteLength > 1024 * 1024) return // 单帧上限 1MB（B站帧为 KB 级），防海量字节涌入 IPC
    ipcRenderer.send(IPC.wvFrame, new Uint8Array(d.buf))
  } else if (d.__LDA__ === 'ws-meta') {
    ipcRenderer.send(IPC.wvWsMeta, d.url ?? '')
  } else if (d.__LDA__ === 'ws-hook-installed') {
    ipcRenderer.send(IPC.wvInjectReady)
  } else if (d.__LDA__ === 'dom-ready') {
    ipcRenderer.send(IPC.wvDomReady)
  } else if (d.__LDA__ === 'dom-messages' && Array.isArray(d.messages)) {
    ipcRenderer.send(IPC.wvDomMessages, d.messages)
  } else if (d.__LDA__ === 'dy-frame' && d.buf instanceof ArrayBuffer) {
    if (d.buf.byteLength > 4 * 1024 * 1024) return // 抖音帧含批量消息，上限放宽到 4MB
    ipcRenderer.send(IPC.wvDouyinFrame, new Uint8Array(d.buf))
  } else if (d.__LDA__ === 'dy-body' && d.buf instanceof ArrayBuffer) {
    if (d.buf.byteLength > 16 * 1024 * 1024) return
    ipcRenderer.send(IPC.wvDouyinBody, new Uint8Array(d.buf))
  } else if (d.__LDA__ === 'ks-frame' && d.buf instanceof ArrayBuffer) {
    if (d.buf.byteLength > 4 * 1024 * 1024) return
    ipcRenderer.send(IPC.wvKuaishouFrame, new Uint8Array(d.buf))
  }
})

// 主进程 → preload → 主世界（发送文本指令，M3 使用）
contextBridge.exposeInMainWorld('__ldaWv', {
  onSendText: (cb: (text: string) => void): void => {
    ipcRenderer.on(IPC.wvSendText, (_e, text: string) => {
      window.postMessage({ __LDA__: 'do-send', text }, '*')
    })
  }
})
