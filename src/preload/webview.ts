import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'

// 主世界 → preload → 主进程（弹幕帧 / WS 元信息 / 注入就绪 / DOM 兜底消息）
window.addEventListener('message', (ev) => {
  const d = ev.data as {
    __LDA__?: string
    buf?: ArrayBuffer
    url?: string
    messages?: Array<{ nickname: string; content: string }>
  } | null
  if (!d || typeof d !== 'object' || !d.__LDA__) return
  if (d.__LDA__ === 'ws-frame' && d.buf instanceof ArrayBuffer) {
    ipcRenderer.send(IPC.wvFrame, new Uint8Array(d.buf))
  } else if (d.__LDA__ === 'ws-meta') {
    ipcRenderer.send(IPC.wvWsMeta, d.url ?? '')
  } else if (d.__LDA__ === 'ws-hook-installed') {
    ipcRenderer.send(IPC.wvInjectReady)
  } else if (d.__LDA__ === 'dom-messages' && Array.isArray(d.messages)) {
    ipcRenderer.send('wv:dom-messages', d.messages)
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
