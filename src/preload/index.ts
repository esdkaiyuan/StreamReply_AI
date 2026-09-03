import { contextBridge } from 'electron'
contextBridge.exposeInMainWorld('lda', { version: '0.1.0' })
