import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddRoomResult,
  AiLogEntry,
  AiState,
  AppSettings,
  DanmakuMessage,
  HistoryDanmaku,
  HistoryQuery,
  HistoryReply,
  HistoryResult,
  LoginState,
  Platform,
  QrPollResult,
  QrSession,
  ReplySnapshot,
  RoomInfo,
  RoomStatEvent,
  SendResult,
  VideoRect
} from '../shared/types'
import { IPC } from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  addRoom: (input: string, platform?: Platform): Promise<AddRoomResult> =>
    ipcRenderer.invoke(IPC.roomAdd, input, platform),
  removeRoom: (roomId: string): Promise<void> => ipcRenderer.invoke(IPC.roomRemove, roomId),
  listRooms: (): Promise<RoomInfo[]> => ipcRenderer.invoke(IPC.roomList),
  /**
   * 上报「直播画面」占位区矩形；主进程据此把该房间的原生视图搬进可见区域。
   * roomId 或 rect 为 null 表示隐藏所有画面。
   */
  setVideoTarget: (roomId: string | null, rect: VideoRect | null): void =>
    ipcRenderer.send(IPC.videoSetTarget, roomId, rect),
  onDanmaku: (cb: (m: DanmakuMessage) => void) => subscribe(IPC.danmaku, cb),
  onRoomStatus: (cb: (r: RoomInfo) => void) => subscribe(IPC.roomStatusChanged, cb),
  onRoomStat: (cb: (s: RoomStatEvent) => void) => subscribe(IPC.roomStat, cb),
  onReplyUpdate: (cb: (s: ReplySnapshot) => void) => subscribe(IPC.replyUpdate, cb),
  confirmReply: (id: string): Promise<void> => ipcRenderer.invoke(IPC.replyConfirm, id),
  rejectReply: (id: string): Promise<void> => ipcRenderer.invoke(IPC.replyReject, id),
  retryReply: (id: string): Promise<void> => ipcRenderer.invoke(IPC.replyRetry, id),
  editReply: (id: string, text: string): Promise<void> =>
    ipcRenderer.invoke(IPC.replyEdit, id, text),
  manualReply: (msg: DanmakuMessage): Promise<boolean> =>
    ipcRenderer.invoke(IPC.replyManual, msg),
  manualSend: (roomId: string, text: string): Promise<SendResult> =>
    ipcRenderer.invoke(IPC.manualSend, roomId, text),
  onAiLog: (cb: (e: AiLogEntry) => void) => subscribe(IPC.aiLog, cb),
  onAiState: (cb: (s: AiState) => void) => subscribe(IPC.aiState, cb),
  queryDanmaku: (q: HistoryQuery = {}): Promise<HistoryResult<HistoryDanmaku>> =>
    ipcRenderer.invoke(IPC.historyDanmaku, q),
  queryReplies: (q: HistoryQuery = {}): Promise<HistoryResult<HistoryReply>> =>
    ipcRenderer.invoke(IPC.historyReplies, q),
  toggleAi: (): Promise<boolean> => ipcRenderer.invoke(IPC.aiToggle),
  getLoginState: (): Promise<LoginState> => ipcRenderer.invoke(IPC.authState),
  onLoginChanged: (cb: (s: LoginState) => void) => subscribe(IPC.authChanged, cb),
  startQrLogin: (): Promise<{ ok: true; session: QrSession } | { ok: false; error: string }> =>
    ipcRenderer.invoke(IPC.authQrStart),
  pollQrLogin: (key: string): Promise<QrPollResult> => ipcRenderer.invoke(IPC.authQrPoll, key),
  loginWithCookie: (raw: string): Promise<LoginState & { error?: string }> =>
    ipcRenderer.invoke(IPC.authCookieSet, raw),
  openLoginWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.authOpenLoginWindow),
  logout: (): Promise<LoginState> => ipcRenderer.invoke(IPC.authLogout),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.settingsSet, patch)
}

contextBridge.exposeInMainWorld('lda', api)
export type LdaApi = typeof api
