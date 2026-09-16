import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/types'
import type { DanmakuMessage, Platform } from '../../shared/types'
import { openRoom, closeRoom, listRooms, bindMainWindow } from '../webview/webviewManager'
import { detectPlatform, getAdapter } from '../adapters'
import { bus } from '../webview/bus'

/** 当前绑定的主窗口；activate 重建窗口后经 rebindRoomWindow 更新 */
let boundWin: BrowserWindow | null = null

function push(channel: string, payload: unknown): void {
  if (boundWin && !boundWin.isDestroyed()) boundWin.webContents.send(channel, payload)
}

/** 窗口重建（macOS activate）后重新绑定推送目标与 webviewManager 的主窗口引用 */
export function rebindRoomWindow(win: BrowserWindow): void {
  boundWin = win
  bindMainWindow(win)
}

export function registerRoomIpc(win: BrowserWindow): void {
  rebindRoomWindow(win)

  bus.on('danmaku', (msg: DanmakuMessage) => {
    push(IPC.danmaku, msg)
  })
  // 每 10 秒推送一次各房间统计
  setInterval(() => {
    for (const room of listRooms()) {
      if (room.status === 'closed') continue
      push(IPC.roomStat, {
        platform: room.platform,
        roomId: room.roomId,
        danmakuRate: bus.rate60s(),
        ts: Date.now()
      })
    }
  }, 10_000).unref()

  // platform 省略时按输入域名自动识别，识别不出按 B 站（一期行为）
  ipcMain.handle(IPC.roomAdd, async (_e, input: string, platform?: Platform) => {
    let text = String(input ?? '').trim()
    if (!text) return { ok: false, error: '请输入直播间地址或房间号' }
    const resolved = platform ?? detectPlatform(text) ?? 'bilibili'
    const adapter = getAdapter(resolved)
    if (!adapter) return { ok: false, error: `平台「${resolved}」尚未支持` }
    // 分享短链（v.douyin.com / v.kuaishou.com）里不含房间号，先让平台自己归一化。
    // 归一化失败就沿用原输入，由下面的 parseRoomId 给出「无法解析」的明确提示。
    if (adapter.normalizeInput) {
      try {
        text = (await adapter.normalizeInput(text)) || text
      } catch (err) {
        console.warn(`[rooms] ${resolved} 输入归一化失败，按原输入解析：`, String(err))
      }
    }
    // 按平台各自的房间号格式解析（快手是字母数字 ID，不是纯数字）
    const roomId = adapter.parseRoomId(text)
    if (!roomId) return { ok: false, error: `无法从输入中解析 ${resolved} 的房间号` }
    try {
      await openRoom(resolved, roomId)
      return { ok: true }
    } catch (err) {
      closeRoom(roomId) // 清理已入表的会话，避免永久卡在「连接中」
      return { ok: false, error: `打开直播间失败：${String(err)}` }
    }
  })

  ipcMain.handle(IPC.roomRemove, (_e, roomId: string) => {
    closeRoom(String(roomId))
  })

  ipcMain.handle(IPC.roomList, () => listRooms())
}
