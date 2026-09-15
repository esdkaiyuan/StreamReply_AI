import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type Store from 'electron-store'
import type { AiLogLevel, DanmakuMessage, ReplyTask } from '../../shared/types'
import { IPC } from '../../shared/types'
import type { AppSettings } from '../../shared/types'
import { GlmClient } from './client'
import { parseReply } from './schema'
import { buildPrompt } from './prompt'
import { shouldReply } from './trigger'
import { ReplyFilter } from '../sender/filter'
import { SendScheduler } from '../sender/scheduler'
import { effectiveApiKey, hasApiKey } from '../settings'
import { bus } from '../webview/bus'
import { sendText } from '../webview/webviewManager'
import type { DbStore } from '../db/store'

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

export function startReplyPipeline(
  win: BrowserWindow,
  settings: Store<AppSettings>,
  db: DbStore | null = null
): void {
  rebindReplyWindow(win)

  const glm = new GlmClient({
    get baseUrl() {
      return settings.get('glmBaseUrl')
    },
    get apiKey() {
      return effectiveApiKey(settings)
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
    sender: async (task) => {
      const result = await sendText(task.roomId, task.text)
      db?.saveReply({ ...task, status: result.ok ? 'sent' : 'failed', sentAt: Date.now() })
      log(
        result.ok ? 'info' : 'error',
        result.ok
          ? `已发送给 ${task.replyTo}：${task.text}`
          : `发送失败（${result.reason ?? '未知原因'}）：${task.text}`
      )
      return result.ok
    },
    onEvent: () => pushSnapshot()
  })

  function pushSnapshot(): void {
    push(IPC.replyUpdate, scheduler.snapshot())
  }

  /** 把「为什么没回复」暴露到 UI，避免全链路静默 */
  function log(level: AiLogLevel, message: string, nickname?: string): void {
    push(IPC.aiLog, { level, message, nickname, ts: Date.now() })
    if (level === 'error') console.error('[ai]', message)
  }

  function pushState(): void {
    push(IPC.aiState, {
      aiEnabled: settings.get('aiEnabled'),
      hasApiKey: hasApiKey(settings),
      model: settings.get('glmModel'),
      dbAvailable: db !== null
    })
  }

  ipcMain.handle(IPC.replyEdit, (_e, id: string, text: string) => {
    scheduler.edit(String(id), String(text ?? '').slice(0, 40))
    pushSnapshot()
  })

  /** 手动为指定弹幕生成一条回复（不看触发器开关，但需配置 Key） */
  ipcMain.handle(IPC.replyManual, async (_e, msg: DanmakuMessage) => {
    if (!hasApiKey(settings)) {
      log('error', '未配置 GLM API Key，无法生成回复')
      return false
    }
    await handleDanmaku(msg, recentByRoom.get(msg.roomId) ?? [])
    return true
  })

  /** 手动发弹幕：用户显式操作，直接发，不再排队 */
  ipcMain.handle(IPC.manualSend, async (_e, roomId: string, text: string) => {
    const content = String(text ?? '').trim()
    if (!content) return { ok: false, reason: '内容为空' }
    const result = await sendText(String(roomId), content)
    if (result.ok) {
      db?.saveReply({
        id: randomUUID(),
        roomId: String(roomId),
        replyTo: '手动发送',
        text: content,
        emotion: 'answer',
        priority: 'normal',
        status: 'sent',
        createdAt: Date.now(),
        sentAt: Date.now()
      })
    }
    log(
      result.ok ? 'info' : 'error',
      result.ok ? `手动发送成功：${content}` : `手动发送失败（${result.reason ?? '未知原因'}）：${content}`
    )
    return result
  })

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
    const enabled = settings.get('aiEnabled')
    log('info', enabled ? 'AI 回复已开启' : 'AI 回复已关闭')
    pushState()
    return enabled
  })
  ipcMain.handle(IPC.settingsGet, () => settings.store)
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
    settings.set(patch as never)
    pushState()
    return settings.store
  })

  pushState()

  bus.on('danmaku', (msg: DanmakuMessage) => {
    db?.enqueueDanmaku(msg)
    const recent = recentByRoom.get(msg.roomId) ?? []
    recent.push(msg)
    if (recent.length > MAX_CONTEXT) recent.splice(0, recent.length - MAX_CONTEXT)
    recentByRoom.set(msg.roomId, recent)

    if (!settings.get('aiEnabled') || !hasApiKey(settings)) return
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
      if (!reply) {
        log('warn', 'AI 输出不是合法 JSON，已丢弃', msg.user.nickname)
        return
      }
      if (reply.action !== 'reply' || !reply.text) {
        log('info', `AI 判断无需回复：${reply.reason || '未说明'}`, msg.user.nickname)
        return
      }

      filter.setSensitiveWords(settings.get('sensitiveWords'))
      if (!filter.passesText(reply.text)) {
        log('warn', `回复被敏感词/重复过滤拦截：${reply.text}`, msg.user.nickname)
        return
      }

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
      log('info', `已生成回复 → ${msg.user.nickname}：${reply.text}`, msg.user.nickname)
      pushSnapshot()
    } catch (err) {
      log('error', `AI 生成失败：${err instanceof Error ? err.message : String(err)}`, msg.user.nickname)
    }
  }

  async function chatAsString(system: string, user: string): Promise<string> {
    const raw = await glm.chatJson(system, user)
    return typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
}
