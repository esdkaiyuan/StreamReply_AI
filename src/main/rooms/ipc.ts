import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/types'
import type { DanmakuMessage } from '../../shared/types'
import { openRoom, closeRoom, listRooms, bindMainWindow } from '../webview/webviewManager'
import { bus } from '../webview/bus'

const ROOM_ID_RE = /(\d{4,})/

export function registerRoomIpc(win: BrowserWindow): void {
  bindMainWindow(win)

  bus.on('danmaku', (msg: DanmakuMessage) => {
    win.webContents.send(IPC.danmaku, msg)
  })
  // 每 10 秒推送一次各房间统计
  setInterval(() => {
    for (const room of listRooms()) {
      if (room.status === 'closed') continue
      win.webContents.send(IPC.roomStat, {
        platform: room.platform,
        roomId: room.roomId,
        danmakuRate: bus.rate60s(),
        ts: Date.now()
      })
    }
  }, 10_000).unref()

  ipcMain.handle(IPC.roomAdd, (_e, input: string) => {
    const text = String(input ?? '').trim()
    if (!text) return { ok: false, error: '请输入直播间地址或房间号' }
    const m = text.match(ROOM_ID_RE)
    if (!m) return { ok: false, error: '无法从输入中解析房间号' }
    void openRoom('bilibili', m[1])
    return { ok: true }
  })

  ipcMain.handle(IPC.roomRemove, (_e, roomId: string) => {
    closeRoom(String(roomId))
  })

  ipcMain.handle(IPC.roomList, () => listRooms())
}
