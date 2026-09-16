import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type Store from 'electron-store'
import type { AiLogLevel, DanmakuMessage, ReplyTask } from '../../shared/types'
import { IPC } from '../../shared/types'
import type { AppSettings } from '../../shared/types'
import { GlmClient } from './client'
import { parseReply } from './schema'
import { buildPrompt } from './prompt'
import { shouldReply, pickRandomDanmaku } from './trigger'
import { RandomReplyTimer } from './randomTimer'
import { ReplyFilter } from '../sender/filter'
import { SendScheduler } from '../sender/scheduler'
import { effectiveApiKey, hasApiKey } from '../settings'
import { bus } from '../webview/bus'
import { sendText } from '../webview/webviewManager'
import type { DbStore } from '../db/store'

/** 送进 prompt 的上下文条数 */
const MAX_CONTEXT = 40
/** 每个房间保留的弹幕缓冲上限（随机模式要从里面挑，故比 prompt 上下文宽） */
const BUFFER_MAX = 200
const MAX_INFLIGHT = 3
/** 已回复消息 id 的去重集合上限，超过就丢一半，避免无界增长 */
const REPLIED_ID_MAX = 1000

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
  /** 已回复过的弹幕 id：随机模式靠它去重，避免同一条被反复回复 */
  const repliedMsgIds = new Set<string>()
  /** 上一条随机回复的对象昵称，用于尽量不连着回同一个人 */
  let lastRandomNickname: string | undefined
  let inflight = 0

  const scheduler = new SendScheduler({
    get minDelayMs() {
      return settings.get('replyGapMinSec') * 1000
    },
    get maxDelayMs() {
      return settings.get('replyGapMaxSec') * 1000
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

  /**
   * 「随机」模式的节拍器：不看内容，按随机间隔主动挑一条最近的弹幕回复。
   * 每次触发都重新取随机值，避免形成可识别的固定周期。
   */
  const randomTimer = new RandomReplyTimer({
    getMinMs: () => settings.get('randomIntervalMinSec') * 1000,
    getMaxMs: () => settings.get('randomIntervalMaxSec') * 1000,
    onFire: () => pickRandomAndReply()
  })

  function pickRandomAndReply(): void {
    if (!settings.get('aiEnabled')) return
    if (settings.get('triggerMode') !== 'random') return
    if (!hasApiKey(settings)) return
    if (inflight >= MAX_INFLIGHT) return

    const poolSize = Math.max(1, Math.min(BUFFER_MAX, settings.get('randomPoolSize') || 1))
    const pool: DanmakuMessage[] = []
    for (const list of recentByRoom.values()) pool.push(...list.slice(-poolSize))

    const picked = pickRandomDanmaku(pool, repliedMsgIds, Math.random, lastRandomNickname)
    if (!picked) {
      log('info', '随机回复：暂无可回复的弹幕（缓冲为空或都回复过了），等待下一轮')
      return
    }
    rememberReplied(picked)
    lastRandomNickname = picked.user.nickname
    inflight += 1
    void handleDanmaku(picked, recentByRoom.get(picked.roomId) ?? []).finally(() => {
      inflight -= 1
    })
  }

  function rememberReplied(msg: DanmakuMessage): void {
    repliedMsgIds.add(msg.id)
    if (repliedMsgIds.size > REPLIED_ID_MAX) {
      const drop = Math.floor(REPLIED_ID_MAX / 2)
      let i = 0
      for (const id of repliedMsgIds) {
        repliedMsgIds.delete(id)
        if (++i >= drop) break
      }
    }
  }

  /** 随机模式的启停/重排：开关、Key、触发模式、间隔任何一项变化都要同步 */
  function syncRandomTimer(): void {
    const shouldRun =
      settings.get('aiEnabled') &&
      hasApiKey(settings) &&
      settings.get('triggerMode') === 'random'
    if (!shouldRun) {
      randomTimer.stop()
      return
    }
    if (randomTimer.isRunning) randomTimer.reschedule()
    else randomTimer.start()
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
    rememberReplied(msg)
    const recent = (recentByRoom.get(msg.roomId) ?? []).slice(-MAX_CONTEXT)
    await handleDanmaku(msg, recent)
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
    log(
      'info',
      enabled
        ? settings.get('triggerMode') === 'random'
          ? 'AI 回复已开启（随机模式：按随机间隔主动挑弹幕回复）'
          : 'AI 回复已开启'
        : 'AI 回复已关闭'
    )
    syncRandomTimer()
    pushState()
    return enabled
  })
  ipcMain.handle(IPC.settingsGet, () => settings.store)
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
    settings.set(patch as never)
    // 间隔/触发模式改了要立刻按新节奏重排，否则用户以为没生效
    syncRandomTimer()
    pushState()
    return settings.store
  })

  pushState()
  syncRandomTimer()

  bus.on('danmaku', (msg: DanmakuMessage) => {
    db?.enqueueDanmaku(msg)
    const recent = recentByRoom.get(msg.roomId) ?? []
    recent.push(msg)
    if (recent.length > BUFFER_MAX) recent.splice(0, recent.length - BUFFER_MAX)
    recentByRoom.set(msg.roomId, recent)

    if (!settings.get('aiEnabled') || !hasApiKey(settings)) return
    if (!shouldReply(msg, settings.get('triggerMode'), settings.get('keywords'))) return
    if (inflight >= MAX_INFLIGHT) return

    rememberReplied(msg)
    inflight += 1
    void handleDanmaku(msg, recent.slice(-MAX_CONTEXT)).finally(() => {
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
