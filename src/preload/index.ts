import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddRoomResult,
  AppSettings,
  DanmakuMessage,
  ReplySnapshot,
  RoomInfo,
  RoomStatEvent
} from '../shared/types'
import { IPC } from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  addRoom: (input: string): Promise<AddRoomResult> =>
    ipcRenderer.invoke(IPC.roomAdd, input),
  removeRoom: (roomId: string): Promise<void> => ipcRenderer.invoke(IPC.roomRemove, roomId),
  listRooms: (): Promise<RoomInfo[]> => ipcRenderer.invoke(IPC.roomList),
  onDanmaku: (cb: (m: DanmakuMessage) => void) => subscribe(IPC.danmaku, cb),
  onRoomStatus: (cb: (r: RoomInfo) => void) => subscribe(IPC.roomStatusChanged, cb),
  onRoomStat: (cb: (s: RoomStatEvent) => void) => subscribe(IPC.roomStat, cb),
  onReplyUpdate: (cb: (s: ReplySnapshot) => void) => subscribe(IPC.replyUpdate, cb),
  confirmReply: (id: string): Promise<void> => ipcRenderer.invoke(IPC.replyConfirm, id),
  rejectReply: (id: string): Promise<void> => ipcRenderer.invoke(IPC.replyReject, id),
  retryReply: (id: string): Promise<void> => ipcRenderer.invoke(IPC.replyRetry, id),
  toggleAi: (): Promise<boolean> => ipcRenderer.invoke(IPC.aiToggle),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsSet, patch)
}

contextBridge.exposeInMainWorld('lda', api)
export type LdaApi = typeof api
