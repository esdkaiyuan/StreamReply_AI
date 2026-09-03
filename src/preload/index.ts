import { contextBridge, ipcRenderer } from 'electron'
import type { DanmakuMessage, RoomInfo, RoomStatEvent } from '../shared/types'
import { IPC } from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  addRoom: (input: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.roomAdd, input),
  removeRoom: (roomId: string): Promise<void> => ipcRenderer.invoke(IPC.roomRemove, roomId),
  listRooms: (): Promise<RoomInfo[]> => ipcRenderer.invoke(IPC.roomList),
  onDanmaku: (cb: (m: DanmakuMessage) => void) => subscribe(IPC.danmaku, cb),
  onRoomStatus: (cb: (r: RoomInfo) => void) => subscribe(IPC.roomStatusChanged, cb),
  onRoomStat: (cb: (s: RoomStatEvent) => void) => subscribe(IPC.roomStat, cb)
}

contextBridge.exposeInMainWorld('lda', api)
export type LdaApi = typeof api
