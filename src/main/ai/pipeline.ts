import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type Store from 'electron-store'
import type { DanmakuMessage, ReplyTask } from '../../shared/types'
import { IPC } from '../../shared/types'
import type { AppSettings } from '../../shared/types'
import { GlmClient } from './client'
import { parseReply } from './schema'
import { buildPrompt } from './prompt'
import { shouldReply } from './trigger'
import { ReplyFilter } from '../sender/filter'
import { SendScheduler } from '../sender/scheduler'
import { bus } from '../webview/bus'
import { sendText } from '../webview/webviewManager'

const MAX_CONTEXT = 40
const MAX_INFLIGHT = 3

let targetWin: BrowserWindow | null = null

function push(channel: string, payload: unknown): void {
  if (targetWin && !targetWin.isDestroyed()) targetWin.webContents.send(channel, payload)
}

/** 窗口重建（macOS activate）后重新绑定回复面板推送目标 */
export function rebindReplyWindow(win: BrowserWindow): void {
  targetWin = win
}

export function startReplyPipeline(win: BrowserWindow, settings: Store<AppSettings>): void {
  rebindReplyWindow(win)

  const glm = new GlmClient({
    get baseUrl() {
      return settings.get('glmBaseUrl')
    },
    get apiKey() {
      return settings.get('glmApiKey')
    },
    get model() {
      return settings.get('glmModel')
    }
  })
  const filter = new ReplyFilter(settings.get('sensitiveWords'))
  const recentByRoom = new Map<string, DanmakuMessage[]>()
  const repliedByRoom = new Map<string, Array<{ user: string; reply: string }>>()
  let inflight = 0

  const scheduler = new SendScheduler({
    get minDelayMs() {
      return 8000
    },
    get maxDelayMs() {
      return 25000
    },
    get maxPerMinute() {
      return settings.get('maxPerMinute')
    },
    get maxPerHour() {
      return settings.get('maxPerHour')
    },
    get requireConfirm() {
      return settings.get('requireConfirm')
    },
    sender: (text, roomId) => sendText(roomId, text),
    onEvent: () => pushSnapshot()
  })

  function pushSnapshot(): void {
    push(IPC.replyUpdate, scheduler.snapshot())
  }

  ipcMain.handle(IPC.replyConfirm, (_e, id: string) => {
    scheduler.confirm(id)
    pushSnapshot()
  })
  ipcMain.handle(IPC.replyReject, (_e, id: string) => {
    scheduler.reject(id)
    pushSnapshot()
  })
  ipcMain.handle(IPC.replyRetry, (_e, id: string) => {
    scheduler.retry(id)
    pushSnapshot()
  })
  ipcMain.handle(IPC.aiToggle, () => {
    settings.set('aiEnabled', !settings.get('aiEnabled'))
    return settings.get('aiEnabled')
  })
  ipcMain.handle(IPC.settingsGet, () => settings.store)
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
    settings.set(patch as never)
    return settings.store
  })

  bus.on('danmaku', (msg: DanmakuMessage) => {
    const recent = recentByRoom.get(msg.roomId) ?? []
    recent.push(msg)
    if (recent.length > MAX_CONTEXT) recent.splice(0, recent.length - MAX_CONTEXT)
    recentByRoom.set(msg.roomId, recent)

    if (!settings.get('aiEnabled') || !settings.get('glmApiKey')) return
    if (!shouldReply(msg, settings.get('triggerMode'), settings.get('keywords'))) return
    if (inflight >= MAX_INFLIGHT) return

    inflight += 1
    void handleDanmaku(msg, recent).finally(() => {
      inflight -= 1
    })
  })

  async function handleDanmaku(msg: DanmakuMessage, recent: DanmakuMessage[]): Promise<void> {
    const repliedPairs = repliedByRoom.get(msg.roomId) ?? []
    const { system, user } = buildPrompt(settings.get('persona'), recent, msg, repliedPairs)
    try {
      let reply = parseReply(await chatAsString(system, user))
      if (!reply) {
        // 规格第 5 节：校验失败重试 1 次，仍失败则丢弃并记日志
        reply = parseReply(await chatAsString(system, user))
      }
      if (!reply || reply.action !== 'reply' || !reply.text) return

      filter.setSensitiveWords(settings.get('sensitiveWords'))
      if (!filter.passesText(reply.text)) return

      const task: ReplyTask = {
        id: randomUUID(),
        roomId: msg.roomId,
        replyTo: msg.user.nickname,
        text: reply.text,
        emotion: reply.emotion,
        priority: reply.priority,
        status: 'queued',
        reason: reply.reason,
        createdAt: Date.now()
      }
      repliedPairs.push({ user: msg.user.nickname, reply: reply.text })
      if (repliedPairs.length > 30) repliedPairs.splice(0, repliedPairs.length - 30)
      repliedByRoom.set(msg.roomId, repliedPairs)
      scheduler.enqueue(task)
      pushSnapshot()
    } catch (err) {
      console.error('[ai] reply pipeline error', err)
    }
  }

  async function chatAsString(system: string, user: string): Promise<string> {
    const raw = await glm.chatJson(system, user)
    return typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
}
