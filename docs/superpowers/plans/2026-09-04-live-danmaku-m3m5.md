# 直播弹幕助手 M3+M4+M5 实施计划（AI 回复 + 自动发送 + 持久化打包）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入智谱 GLM（glm-4.5-air）按规范生成回复，经防风控调度器自动发送到直播间，完成设置持久化、SQLite 历史与 Windows 打包。

**Architecture:** 弹幕总线 → 触发规则引擎 → GLM（OpenAI 兼容 + JSON 强制输出 + zod 校验）→ 敏感词/去重过滤 → 优先级调度器（随机延迟/频率上限/熔断/可选人工确认）→ WebView 内 executeJavaScript 模拟发送。设置经 electron-store 持久化（Key 默认读 `.env.local`），弹幕/回复经 better-sqlite3 批量落盘。

**Tech Stack:** 智谱 GLM v4 API、zod、electron-store、better-sqlite3 + @electron/rebuild、electron-builder。

**前置:** `docs/superpowers/plans/2026-09-04-live-danmaku-m1m2.md` 已完成（M1+M2 交付）。规格见 `docs/superpowers/specs/2026-09-03-直播弹幕助手-design.md` 第 5~7 节。

---

### Task 1: IPC 常量扩展与回复任务类型

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: 在 `IPC` 常量对象中追加通道（保持 `as const` 结构）**

```ts
export const IPC = {
  // ...既有通道保持不变（roomAdd/roomRemove/roomList/roomStatusChanged/danmaku/roomStat/wvFrame/wvWsMeta/wvInjectReady/wvSendText）
  replyUpdate: 'reply:update',
  replyConfirm: 'reply:confirm',
  replyReject: 'reply:reject',
  replyRetry: 'reply:retry',
  aiToggle: 'ai:toggle',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set'
} as const
```

- [ ] **Step 2: 在 `types.ts` 末尾追加回复任务类型（与规格第 5 节规范一致）**

```ts
export type Emotion = 'answer' | 'thanks' | 'greet' | 'tease' | 'comfort'
export type ReplyStatus = 'pending-confirm' | 'queued' | 'sending' | 'sent' | 'failed' | 'rejected'

export interface ReplyTask {
  id: string
  roomId: string
  replyTo: string
  text: string
  emotion: Emotion
  priority: 'high' | 'normal' | 'low'
  status: ReplyStatus
  reason?: string
  createdAt: number
  sentAt?: number
}

export type TriggerMode = 'smart' | 'keyword' | 'question' | 'all'
```

- [ ] **Step 3: typecheck + Commit**

Run: `npm run typecheck` → exit 0

```bash
git add src/shared/types.ts
git commit -m "feat(m3): 回复任务类型与回复/设置 IPC 通道常量"
```

---

### Task 2: AI 回复 JSON Schema 校验（TDD）

**Files:**
- Create: `src/main/ai/schema.ts`
- Test: `tests/ai-schema.test.ts`

- [ ] **Step 1: 写失败测试 `tests/ai-schema.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { parseReply } from '../src/main/ai/schema'

describe('ai reply schema', () => {
  it('解析合法 reply 输出', () => {
    const r = parseReply(
      JSON.stringify({
        action: 'reply', reply_to: '小明', text: '你好呀小明！',
        emotion: 'greet', priority: 'normal', reason: '打招呼'
      })
    )
    expect(r).not.toBeNull()
    expect(r!.action).toBe('reply')
    expect(r!.emotion).toBe('greet')
  })

  it('容忍 ```json 代码块包裹', () => {
    const r = parseReply('```json\n{"action":"ignore","text":"","reason":"无意义"}\n```')
    expect(r!.action).toBe('ignore')
  })

  it('text 超长裁剪到 40 字', () => {
    const r = parseReply(JSON.stringify({ action: 'reply', text: '啊'.repeat(50) }))
    expect(r!.text.length).toBe(40)
  })

  it('缺失可选字段时给默认值', () => {
    const r = parseReply('{"action":"reply","text":"ok"}')
    expect(r!.emotion).toBe('answer')
    expect(r!.priority).toBe('normal')
  })

  it('非法 action / 非 JSON 返回 null', () => {
    expect(parseReply('not json')).toBeNull()
    expect(parseReply('{"action":"destroy"}')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（schema.ts 不存在）

- [ ] **Step 3: 实现 `src/main/ai/schema.ts`**

```ts
import { z } from 'zod'

export const replySchema = z.object({
  action: z.enum(['reply', 'ignore']),
  reply_to: z.string().default(''),
  text: z.string().default(''),
  emotion: z.enum(['answer', 'thanks', 'greet', 'tease', 'comfort']).default('answer'),
  priority: z.enum(['high', 'normal', 'low']).default('normal'),
  reason: z.string().default('')
})

export type AiReply = z.infer<typeof replySchema>

const MAX_TEXT_LEN = 40

/** 从模型原始输出提取并校验回复；失败返回 null（规格：不猜、不修） */
export function parseReply(raw: string): AiReply | null {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (match ? match[1] : raw).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return null
  }
  const result = replySchema.safeParse(parsed)
  if (!result.success) return null
  return { ...result.data, text: result.data.text.slice(0, MAX_TEXT_LEN) }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 5 用例 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/schema.ts tests/ai-schema.test.ts
git commit -m "feat(m3): AI回复JSON规范校验与裁剪(TDD)"
```

---

### Task 3: 智谱 GLM 客户端（TDD）

**Files:**
- Create: `src/main/ai/client.ts`
- Test: `tests/glm-client.test.ts`

- [ ] **Step 1: 写失败测试 `tests/glm-client.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlmClient } from '../src/main/ai/client'

const okResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: '{"action":"ignore"}' } }] })
})

describe('glm client', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POST chat/completions 并返回 content', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const client = new GlmClient('https://open.bigmodel.cn/api/paas/v4', 'k-test', 'glm-4.5-air')
    const out = await client.chatJson('sys', 'user')
    expect(out).toEqual({ action: 'ignore' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer k-test')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'glm-4.5-air',
      response_format: { type: 'json_object' }
    })
  })

  it('500 后指数退避重试并成功', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const client = new GlmClient('https://x/v4', 'k', 'glm-4.5-air')
    const p = client.chatJson('s', 'u')
    await vi.advanceTimersByTimeTimeAsyncIfAvailable?.(0)
    await vi.runAllTimersAsync()
    expect(await p).toEqual({ action: 'ignore' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('重试耗尽抛出错误', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GlmClient('https://x/v4', 'k', 'glm-4.5-air')
    const p = expect(client.chatJson('s', 'u')).rejects.toThrow('GLM request failed: 429')
    await vi.runAllTimersAsync()
    await p
    expect(fetchMock).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（client.ts 不存在）

- [ ] **Step 3: 实现 `src/main/ai/client.ts`**

```ts
export interface GlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

const RETRIES = 2
const BACKOFF_MS = [1500, 4000]

/** 智谱 GLM（OpenAI 兼容）JSON 输出客户端，含指数退避重试（规格第 10 节） */
export class GlmClient {
  constructor(private cfg: GlmConfig) {}

  async chatJson(system: string, user: string, temperature = 0.8): Promise<unknown> {
    let lastErr: Error | null = null
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.cfg.apiKey}`
          },
          body: JSON.stringify({
            model: this.cfg.model,
            temperature,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user }
            ]
          })
        })
        if (!res.ok) throw new Error(`GLM request failed: ${res.status}`)
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
        return JSON.parse(data.choices?.[0]?.message?.content ?? '{}')
      } catch (err) {
        lastErr = err as Error
        if (attempt < RETRIES) await sleep(BACKOFF_MS[attempt])
      }
    }
    throw lastErr ?? new Error('GLM request failed')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS（若 fake timers 用例对 `sleep` 不生效导致慢速通过，允许保留真实计时但断言调用次数；重试退避为 1.5s/4s，测试总时长可接受）

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/client.ts tests/glm-client.test.ts
git commit -m "feat(m3): 智谱GLM客户端(OpenAI兼容/JSON输出/退避重试)(TDD)"
```

---

### Task 4: Prompt 组装器（TDD）

**Files:**
- Create: `src/main/ai/prompt.ts`
- Test: `tests/ai-prompt.test.ts`

- [ ] **Step 1: 写失败测试 `tests/ai-prompt.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../src/main/ai/prompt'
import type { DanmakuMessage } from '../src/shared/types'

function dm(nickname: string, content: string, over: Partial<DanmakuMessage> = {}): DanmakuMessage {
  return {
    id: Math.random().toString(36).slice(2), platform: 'bilibili', roomId: '1',
    type: 'chat', user: { uid: nickname, nickname }, content, ts: Date.now(), source: 'ws', ...over
  }
}

describe('prompt builder', () => {
  const persona = '你是一个可爱的二次元主播助手'

  it('system 含人设与输出格式说明', () => {
    const { system } = buildPrompt(persona, [], dm('小明', '主播好'), [])
    expect(system).toContain(persona)
    expect(system).toContain('"action"')
    expect(system).toContain('40')
  })

  it('user 含最近上下文与目标弹幕', () => {
    const history = Array.from({ length: 25 }, (_, i) => dm(`u${i}`, `msg${i}`))
    const { user } = buildPrompt(persona, history, dm('小明', '你玩什么游戏'), [
      { user: '小明', reply: '好的' }
    ])
    expect(user).toContain('msg24') // 截取最近 20 条
    expect(user).not.toContain('msg4\n')
    expect(user).toContain('你玩什么游戏')
    expect(user).toContain('已回复过')
  })

  it('礼物弹幕标记感谢意图', () => {
    const { user } = buildPrompt(persona, [], dm('土豪', '', { type: 'gift' }), [])
    expect(user).toContain('礼物')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test` → Expected: FAIL

- [ ] **Step 3: 实现 `src/main/ai/prompt.ts`**

```ts
import type { DanmakuMessage } from '../../shared/types'

const CONTEXT_WINDOW = 20

const FORMAT_INSTRUCTION = `你是直播间弹幕互动 AI。根据人设回复观众，必须只输出一个 JSON 对象，字段：
{"action":"reply或ignore","reply_to":"用户昵称","text":"回复文本(不超过40字,口语化,符合人设)","emotion":"answer|thanks|greet|tease|comfort","priority":"high|normal|low","reason":"一句话理由"}
规则：
- action=ignore 表示不值得回复（纯表情、刷屏、无意义弹幕），此时 text 留空
- 礼物弹幕必须感谢（priority=high, emotion=thanks）
- 不要重复之前已回复过的内容
- text 严格不超过 40 字`

export function buildPrompt(
  persona: string,
  recent: DanmakuMessage[],
  target: DanmakuMessage,
  repliedPairs: Array<{ user: string; reply: string }>
): { system: string; user: string } {
  const system = `【人设】${persona}\n${FORMAT_INSTRUCTION}`
  const context = recent
    .slice(-CONTEXT_WINDOW)
    .map((m) => `${m.user.nickname}: ${m.content || `(${m.type})`}`)
    .join('\n')
  const replied = repliedPairs
    .slice(-8)
    .map((p) => `${p.user} → ${p.reply}`)
    .join('\n')
  const intent =
    target.type === 'gift'
      ? `观众 ${target.user.nickname} 送出了 ${target.gift?.name ?? '礼物'} ×${target.gift?.count ?? 1}，请感谢。`
      : `观众 ${target.user.nickname} 说：「${target.content}」，请决定是否回复。`
  const user = [
    '【最近弹幕】',
    context || '（暂无）',
    '',
    '【已回复过（避免重复）】',
    replied || '（暂无）',
    '',
    `【本次目标】${intent}`
  ].join('\n')
  return { system, user }
}
```

- [ ] **Step 4: 运行确认通过 + Commit**

Run: `npm test` → PASS

```bash
git add src/main/ai/prompt.ts tests/ai-prompt.test.ts
git commit -m "feat(m3): 人设+上下文prompt组装器(TDD)"
```

---

### Task 5: 触发规则引擎 + 敏感词/去重过滤（TDD）

**Files:**
- Create: `src/main/ai/trigger.ts`, `src/main/sender/filter.ts`
- Test: `tests/trigger-filter.test.ts`

- [ ] **Step 1: 写失败测试 `tests/trigger-filter.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { shouldReply } from '../src/main/ai/trigger'
import { ReplyFilter } from '../src/main/sender/filter'
import type { DanmakuMessage } from '../src/shared/types'

function dm(content: string, type = 'chat'): DanmakuMessage {
  return {
    id: 'x', platform: 'bilibili', roomId: '1', type: type as never,
    user: { uid: 'u', nickname: 'n' }, content, ts: Date.now(), source: 'ws'
  }
}

describe('trigger', () => {
  it('smart: chat 与 gift 触发，enter 不触发', () => {
    expect(shouldReply(dm('hi'), 'smart', [])).toBe(true)
    expect(shouldReply(dm('小花花', 'gift'), 'smart', [])).toBe(true)
    expect(shouldReply(dm('', 'enter'), 'smart', [])).toBe(false)
  })
  it('keyword: 仅命中关键词', () => {
    expect(shouldReply(dm('主播多大'), 'keyword', ['多大', '游戏'])).toBe(true)
    expect(shouldReply(dm('今天天气'), 'keyword', ['多大'])).toBe(false)
  })
  it('question: 仅问句', () => {
    expect(shouldReply(dm('你玩什么游戏？'), 'question', [])).toBe(true)
    expect(shouldReply(dm('来了来了'), 'question', [])).toBe(false)
  })
  it('all: 所有 chat 触发', () => {
    expect(shouldReply(dm(''), 'all', [])).toBe(true)
  })
})

describe('filter', () => {
  it('命中敏感词拒绝', () => {
    const f = new ReplyFilter(['赌博', '加微信'])
    expect(f.passesText('来赌博吗')).toBe(false)
    expect(f.passesText('你好呀')).toBe(true)
  })
  it('同内容 10 分钟内去重', () => {
    const f = new ReplyFilter([])
    expect(f.passesText('欢迎欢迎')).toBe(true)
    expect(f.passesText('欢迎欢迎')).toBe(false)
  })
  it('不同内容不受影响', () => {
    const f = new ReplyFilter([])
    f.passesText('A')
    expect(f.passesText('B')).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test` → Expected: FAIL

- [ ] **Step 3: 实现 `src/main/ai/trigger.ts`**

```ts
import type { DanmakuMessage, TriggerMode } from '../../shared/types'

const QUESTION_RE = /[？?]|吗|呢/

/** 规格第 7 节触发规则；礼物在任何模式都触发感谢 */
export function shouldReply(msg: DanmakuMessage, mode: TriggerMode, keywords: string[]): boolean {
  if (msg.type === 'gift') return true
  if (msg.type !== 'chat') return false
  switch (mode) {
    case 'all':
      return true
    case 'question':
      return QUESTION_RE.test(msg.content)
    case 'keyword':
      return keywords.some((k) => k.trim() && msg.content.includes(k.trim()))
    case 'smart':
    default:
      return true // AI 自行决定 ignore
  }
}
```

- [ ] **Step 4: 实现 `src/main/sender/filter.ts`**

```ts
const DEDUP_WINDOW_MS = 10 * 60 * 1000

/** 规格第 6 节：敏感词过滤 + 同内容 10 分钟去重 */
export class ReplyFilter {
  private lastSeen = new Map<string, number>()

  constructor(private sensitiveWords: string[]) {}

  passesText(text: string, now = Date.now()): boolean {
    if (this.sensitiveWords.some((w) => w.trim() && text.includes(w.trim()))) return false
    const last = this.lastSeen.get(text)
    if (last !== undefined && now - last < DEDUP_WINDOW_MS) return false
    return true
  }

  /** 发送成功后记录，避免同文本短时间内重发 */
  markSent(text: string, now = Date.now()): void {
    this.lastSeen.set(text, now)
    if (this.lastSeen.size > 500) {
      for (const [k, t] of this.lastSeen) {
        if (now - t > DEDUP_WINDOW_MS) this.lastSeen.delete(k)
      }
    }
  }
}
```

- [ ] **Step 5: 运行确认通过 + Commit**

Run: `npm test` → PASS

```bash
git add src/main/ai/trigger.ts src/main/sender/filter.ts tests/trigger-filter.test.ts
git commit -m "feat(m3): 触发规则引擎与敏感词/去重过滤(TDD)"
```

---

### Task 6: 发送调度器（TDD, fake timers）

**Files:**
- Create: `src/main/sender/scheduler.ts`
- Test: `tests/scheduler.test.ts`

- [ ] **Step 1: 写失败测试 `tests/scheduler.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SendScheduler, type SendTask } from '../src/main/sender/scheduler'

function task(partial: Partial<SendTask> = {}): SendTask {
  return {
    id: Math.random().toString(36).slice(2), roomId: '1', replyTo: 'u',
    text: 'hello', emotion: 'answer', priority: 'normal', status: 'queued',
    createdAt: Date.now(), ...partial
  }
}

describe('send scheduler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('随机延迟后按顺序发送', async () => {
    const sent: string[] = []
    const s = new SendScheduler({
      minDelayMs: 8000, maxDelayMs: 25000, maxPerMinute: 2, maxPerHour: 100,
      requireConfirm: false,
      sender: async (t) => { sent.push(t); return true }
    })
    s.enqueue(task({ text: 'a', priority: 'normal' }))
    s.enqueue(task({ text: 'b', priority: 'high' }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sent).toEqual(['b', 'a']) // high 优先
    expect(s.snapshot().sentLastMinute).toBe(2)
  })

  it('每分钟 2 条上限：第三条等到下一窗口', async () => {
    const sent: string[] = []
    const s = new SendScheduler({
      minDelayMs: 0, maxDelayMs: 0, maxPerMinute: 2, maxPerHour: 100,
      requireConfirm: false,
      sender: async (t) => { sent.push(t); return true }
    })
    s.enqueue(task({ text: 'a' }))
    s.enqueue(task({ text: 'b' }))
    s.enqueue(task({ text: 'c' }))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sent.length).toBe(2)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(sent.length).toBe(3)
  })

  it('requireConfirm 时先进入 pending-confirm，确认后才发', async () => {
    const sent: string[] = []
    const s = new SendScheduler({
      minDelayMs: 0, maxDelayMs: 0, maxPerMinute: 10, maxPerHour: 100,
      requireConfirm: true,
      sender: async (t) => { sent.push(t); return true }
    })
    const t = task({ text: 'x' })
    s.enqueue(t)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sent).toEqual([])
    const pending = s.pendingConfirm()
    expect(pending).toHaveLength(1)
    s.confirm(pending[0].id)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sent).toEqual(['x'])
  })

  it('连续失败 3 次熔断 5 分钟', async () => {
    const sender = vi.fn(async () => false)
    const onEvent = vi.fn()
    const s = new SendScheduler({
      minDelayMs: 0, maxDelayMs: 0, maxPerMinute: 100, maxPerHour: 100,
      requireConfirm: false, sender, onEvent
    })
    for (let i = 0; i < 3; i++) s.enqueue(task({ text: `t${i}` }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sender).toHaveBeenCalledTimes(3)
    expect(s.isCircuitOpen()).toBe(true)
    s.enqueue(task({ text: 't4' }))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sender).toHaveBeenCalledTimes(3) // 熔断期不发送
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(sender).toHaveBeenCalledTimes(4) // 熔断恢复后继续
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test` → Expected: FAIL

- [ ] **Step 3: 实现 `src/main/sender/scheduler.ts`**

```ts
import type { ReplyTask } from '../../shared/types'

export type SendTask = ReplyTask

export interface SchedulerOptions {
  minDelayMs: number
  maxDelayMs: number
  maxPerMinute: number
  maxPerHour: number
  requireConfirm: boolean
  sender: (text: string, roomId: string) => Promise<boolean>
  onEvent?: (tasks: SendTask[]) => void
}

const CIRCUIT_FAILURES = 3
const CIRCUIT_MS = 5 * 60 * 1000
const TICK_MS = 500
const MAX_HISTORY = 50

/**
 * 规格第 6 节防风控调度：优先级队列 + 随机延迟 + 频率硬上限 + 熔断 + 可选人工确认。
 */
export class SendScheduler {
  private queue: SendTask[] = []
  private history: SendTask[] = []
  private sentTimes: number[] = []
  private failures = 0
  private circuitUntil = 0
  private nextSendAt = Date.now()
  private timer: NodeJS.Timeout | null = null

  constructor(private opts: SchedulerOptions) {}

  enqueue(task: SendTask): void {
    if (this.opts.requireConfirm) {
      const pending = { ...task, status: 'pending-confirm' as const }
      this.history.unshift(pending)
      this.emit()
      return
    }
    this.pushQueue({ ...task, status: 'queued' })
  }

  /** 人工确认发送 */
  confirm(id: string): void {
    const idx = this.history.findIndex((t) => t.id === id && t.status === 'pending-confirm')
    if (idx < 0) return
    const [t] = this.history.splice(idx, 1)
    this.pushQueue({ ...t, status: 'queued' })
  }

  /** 人工弃用 */
  reject(id: string): void {
    const t = this.history.find((x) => x.id === id && x.status === 'pending-confirm')
    if (!t) return
    t.status = 'rejected'
    this.emit()
  }

  retry(id: string): void {
    const t = this.history.find((x) => x.id === id && x.status === 'failed')
    if (!t) return
    t.status = 'queued'
    this.emit()
  }

  pendingConfirm(): SendTask[] {
    return this.history.filter((t) => t.status === 'pending-confirm')
  }

  snapshot(): { queue: SendTask[]; history: SendTask[]; sentLastMinute: number; sentLastHour: number } {
    const now = Date.now()
    return {
      queue: this.queue,
      history: this.history,
      sentLastMinute: this.sentTimes.filter((t) => now - t < 60_000).length,
      sentLastHour: this.sentTimes.filter((t) => now - t < 3_600_000).length
    }
  }

  isCircuitOpen(): boolean {
    return Date.now() < this.circuitUntil
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private pushQueue(task: SendTask): void {
    if (task.priority === 'high') {
      const firstNormal = this.queue.findIndex((t) => t.priority !== 'high')
      if (firstNormal < 0) this.queue.push(task)
      else this.queue.splice(firstNormal, 0, task)
    } else {
      this.queue.push(task)
    }
    this.emit()
    this.start()
  }

  private start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    if (this.queue.length === 0) {
      this.stop()
      return
    }
    if (now < this.circuitUntil || now < this.nextSendAt) return
    const minute = this.sentTimes.filter((t) => now - t < 60_000).length
    const hour = this.sentTimes.filter((t) => now - t < 3_600_000).length
    if (minute >= this.opts.maxPerMinute || hour >= this.opts.maxPerHour) return

    const task = this.queue.shift()!
    const range = Math.max(this.opts.maxDelayMs - this.opts.minDelayMs, 0)
    this.nextSendAt = now + this.opts.minDelayMs + Math.floor(Math.random() * range)

    task.status = 'sending'
    this.emit()
    let ok = false
    try {
      ok = await this.opts.sender(task.text, task.roomId)
    } catch {
      ok = false
    }
    task.sentAt = Date.now()
    task.status = ok ? 'sent' : 'failed'
    if (ok) {
      this.failures = 0
      this.sentTimes.push(task.sentAt)
    } else {
      this.failures += 1
      if (this.failures >= CIRCUIT_FAILURES) this.circuitUntil = Date.now() + CIRCUIT_MS
    }
    this.history.unshift(task)
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY
    this.emit()
  }

  private emit(): void {
    this.opts.onEvent?.(this.snapshot().queue.concat(this.snapshot().history))
  }
}
```

- [ ] **Step 4: 运行确认通过 + Commit**

Run: `npm test` → PASS

```bash
git add src/main/sender/scheduler.ts tests/scheduler.test.ts
git commit -m "feat(m4): 防风控发送调度器(优先级/限频/熔断/人工确认)(TDD)"
```

---

### Task 7: 页面发送模拟脚本 + webviewManager 发送出口

**Files:**
- Create: `src/main/webview/inject/sender.ts`
- Modify: `src/main/webview/webviewManager.ts`

- [ ] **Step 1: 写入 `src/main/webview/inject/sender.ts`**

```ts
/** 在页面主世界模拟输入 + 点击发送（带用户登录态，行为与真人一致）。文本经 JSON.stringify 安全嵌入。 */
export function buildSendScript(text: string): string {
  return String.raw`(function () {
  var TEXT = ${JSON.stringify(text)}
  var input = document.querySelector('.chat-input') || document.querySelector('textarea.chat-input')
  if (!input) return 'no-input'
  var proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  input.focus()
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  setter.call(input, TEXT)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  setTimeout(function () {
    var btn = document.querySelector('.bottom-actions .bl-button') ||
              document.querySelector('.chat-control-panel .bl-button') ||
              document.querySelector('.bl-button--primary')
    if (btn) { btn.click(); window.postMessage({ __LDA__: 'send-done' }, '*') }
  }, 200 + Math.floor(Math.random() * 400))
  return 'queued'
})()`
}
```

- [ ] **Step 2: 在 `webviewManager.ts` 追加发送出口（文件末尾 `listRooms` 之后）**

```ts
import { buildSendScript } from './inject/sender'

export async function sendText(roomId: string, text: string): Promise<boolean> {
  const room = rooms.get(roomId)
  if (!room) return false
  try {
    const result = (await room.view.webContents.executeJavaScript(buildSendScript(text))) as string
    // 延迟等待点击结果；找不到输入框视为失败（触发调度器熔断计数）
    return result === 'queued'
  } catch (err) {
    console.error('[wv] sendText failed', err)
    return false
  }
}
```

注意：`import { buildSendScript }` 需放到文件顶部 import 区。

- [ ] **Step 3: typecheck + Commit**

Run: `npm run typecheck` → exit 0

```bash
git add src/main/webview/
git commit -m "feat(m4): 页面内发送模拟脚本与 sendText 出口"
```

---

### Task 8: 设置存储（.env.local 默认值 + electron-store）

**Files:**
- Create: `src/main/settings.ts`, `src/main/envFile.ts`
- Modify: `package.json`（dependencies 追加 `"electron-store": "^10.0.0"`）
- Test: `tests/env-file.test.ts`

- [ ] **Step 1: 安装依赖**

```bash
npm install electron-store@^10.0.0
```

- [ ] **Step 2: 写测试 `tests/env-file.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { parseEnvFile } from '../src/main/envFile'

describe('env file parser', () => {
  it('解析 KEY=VALUE 并忽略注释/空行', () => {
    const env = parseEnvFile('# 注释\nA=1\n\nB=hello world\n')
    expect(env).toEqual({ A: '1', B: 'hello world' })
  })
  it('损坏内容返回空对象', () => {
    expect(parseEnvFile(null)).toEqual({})
  })
})
```

- [ ] **Step 3: 实现 `src/main/envFile.ts`**

```ts
import { readFileSync } from 'fs'
import { join } from 'path'

/** 解析项目根 .env.local（Key 私有配置，gitignore 排除） */
export function parseEnvFile(content: string | null): Record<string, string> {
  if (!content) return {}
  const env: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

export function loadProjectEnv(appPath: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(join(appPath, '.env.local'), 'utf8'))
  } catch {
    return {}
  }
}
```

- [ ] **Step 4: 实现 `src/main/settings.ts`**

```ts
import Store from 'electron-store'
import { app } from 'electron'
import type { TriggerMode } from '../shared/types'
import { loadProjectEnv } from './envFile'

export interface AppSettings {
  glmBaseUrl: string
  glmModel: string
  glmApiKey: string
  persona: string
  triggerMode: TriggerMode
  keywords: string[]
  sensitiveWords: string[]
  requireConfirm: boolean
  maxPerMinute: number
  maxPerHour: number
  aiEnabled: boolean
}

const DEFAULT_PERSONA =
  '你是主播的可爱助手「小糖」，性格活泼元气，说话简短口语化，喜欢用一点语气词，尊称观众为"宝子"。'

export function loadSettings(): Store<AppSettings> {
  const env = loadProjectEnv(app.getAppPath())
  return new Store<AppSettings>({
    defaults: {
      glmBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      glmModel: 'glm-4.5-air',
      glmApiKey: env['ZHIPU_API_KEY'] ?? '',
      persona: DEFAULT_PERSONA,
      triggerMode: 'smart',
      keywords: [],
      sensitiveWords: ['赌博', '刷单', '加微信', '兼职'],
      requireConfirm: true,
      maxPerMinute: 2,
      maxPerHour: 30,
      aiEnabled: false
    }
  })
}
```

- [ ] **Step 5: 测试 + typecheck + Commit**

Run: `npm test`（env-file 2 用例 PASS）；`npm run typecheck` → exit 0

```bash
git add src/main/settings.ts src/main/envFile.ts tests/env-file.test.ts package.json package-lock.json
git commit -m "feat(m3): 设置持久化(electron-store)与.env.local默认Key读取"
```

---

### Task 9: 回复管线（总线 → 触发 → AI → 过滤 → 调度 → 发送）

**Files:**
- Create: `src/main/ai/pipeline.ts`
- Modify: `src/main/index.ts`, `src/main/rooms/ipc.ts`, `src/preload/index.ts`, `src/renderer/src/env.d.ts`

- [ ] **Step 1: 写入 `src/main/ai/pipeline.ts`**

```ts
import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { DanmakuMessage, ReplyTask } from '../shared/types'
import { IPC } from '../shared/types'
import type { Store } from 'electron-store'
import type { AppSettings } from '../settings'
import { GlmClient } from './client'
import { parseReply } from './schema'
import { buildPrompt } from './prompt'
import { shouldReply } from './trigger'
import { ReplyFilter } from '../sender/filter'
import { SendScheduler } from '../sender/scheduler'
import { bus } from '../webview/bus'
import { sendText } from '../webview/webviewManager'

export function startReplyPipeline(win: BrowserWindow, settings: Store<AppSettings>): void {
  const glm = new GlmClient({
    get baseUrl() { return settings.get('glmBaseUrl') },
    get apiKey() { return settings.get('glmApiKey') },
    get model() { return settings.get('glmModel') }
  } as never)
  const filter = new ReplyFilter(settings.get('sensitiveWords'))
  const recent: DanmakuMessage[] = []
  const repliedPairs: Array<{ user: string; reply: string }> = []

  const scheduler = new SendScheduler({
    get minDelayMs() { return 8000 },
    get maxDelayMs() { return 25000 },
    get maxPerMinute() { return settings.get('maxPerMinute') },
    get maxPerHour() { return settings.get('maxPerHour') },
    get requireConfirm() { return settings.get('requireConfirm') },
    sender: (text, roomId) => sendText(roomId, text),
    onEvent: () => pushSnapshot()
  })

  function pushSnapshot(): void {
    win.webContents.send(IPC.replyUpdate, scheduler.snapshot())
  }

  ipcMain.handle(IPC.replyConfirm, (_e, id: string) => { scheduler.confirm(id); pushSnapshot() })
  ipcMain.handle(IPC.replyReject, (_e, id: string) => { scheduler.reject(id); pushSnapshot() })
  ipcMain.handle(IPC.replyRetry, (_e, id: string) => { scheduler.retry(id); pushSnapshot() })
  ipcMain.handle(IPC.aiToggle, () => {
    settings.set('aiEnabled', !settings.get('aiEnabled'))
    return settings.get('aiEnabled')
  })

  bus.on('danmaku', async (msg: DanmakuMessage) => {
    recent.push(msg)
    if (recent.length > 40) recent.splice(0, recent.length - 40)
    if (!settings.get('aiEnabled') || !settings.get('glmApiKey')) return
    if (!shouldReply(msg, settings.get('triggerMode'), settings.get('keywords'))) return

    const { system, user } = buildPrompt(settings.get('persona'), recent, msg, repliedPairs)
    try {
      const raw = (await glm.chatJson(system, user)) as string
      const text0 = typeof raw === 'string' ? raw : JSON.stringify(raw)
      let reply = parseReply(text0)
      if (!reply) {
        // 规格第 5 节：校验失败重试 1 次，仍失败则丢弃并记日志
        const retry = (await glm.chatJson(system, user)) as string
        const text1 = typeof retry === 'string' ? retry : JSON.stringify(retry)
        reply = parseReply(text1)
      }
      if (!reply) {
        console.warn('[ai] invalid reply schema, dropped after 1 retry')
        return
      }
      if (reply.action !== 'reply' || !reply.text) return
      if (!filter.passesText(reply.text)) return
      const task: ReplyTask = {
        id: randomUUID(), roomId: msg.roomId, replyTo: msg.user.nickname,
        text: reply.text, emotion: reply.emotion, priority: reply.priority,
        status: 'queued', reason: reply.reason, createdAt: Date.now()
      }
      repliedPairs.push({ user: msg.user.nickname, reply: reply.text })
      if (repliedPairs.length > 30) repliedPairs.splice(0, repliedPairs.length - 30)
      scheduler.enqueue(task)
      pushSnapshot()
    } catch (err) {
      console.error('[ai] reply pipeline error', err)
    }
  })
}
```

注意：`GlmClient` 构造参数当前是 `{ baseUrl, apiKey, model }` 纯对象；为实现随设置刷新，将 `src/main/ai/client.ts` 的构造签名改为接受 getter 对象：

```ts
export class GlmClient {
  constructor(
    private cfg: { readonly baseUrl: string; readonly apiKey: string; readonly model: string }
  ) {}

  private get conf(): { baseUrl: string; apiKey: string; model: string } {
    return { baseUrl: this.cfg.baseUrl, apiKey: this.cfg.apiKey, model: this.cfg.model }
  }
  // chatJson 内部改用 this.conf 代替 this.cfg（其余逻辑不变）
}
```

同时 `pipeline.ts` 中的 `as never` 断言可移除（getter 对象即满足只读结构）。

- [ ] **Step 2: 修改 `src/main/index.ts` 启动管线**

```ts
import { registerRoomIpc } from './rooms/ipc'
import { loadSettings } from './settings'
import { startReplyPipeline } from './ai/pipeline'

app.whenReady().then(() => {
  const win = createWindow()
  registerRoomIpc(win)
  startReplyPipeline(win, loadSettings())
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
```

- [ ] **Step 3: 扩展 preload 桥（`src/preload/index.ts` 的 api 对象追加）**

```ts
onReplyUpdate: (cb: (s: unknown) => void) => subscribe(IPC.replyUpdate, cb),
confirmReply: (id: string): Promise<void> => ipcRenderer.invoke(IPC.replyConfirm, id),
rejectReply: (id: string): Promise<void> => ipcRenderer.invoke(IPC.replyReject, id),
retryReply: (id: string): Promise<void> => ipcRenderer.invoke(IPC.replyRetry, id),
toggleAi: (): Promise<boolean> => ipcRenderer.invoke(IPC.aiToggle)
```

- [ ] **Step 4: 测试 + typecheck + 手动冒烟**

Run: `npm test && npm run typecheck` → PASS / exit 0
Run: `npm run dev`，设置 API Key 就绪后开启 AI（Task 10 提供 UI 开关；本步可先手动把 store 中 `aiEnabled` 改为 true 验证链路，或跳过至 Task 10 完成后一起冒烟）

- [ ] **Step 5: Commit**

```bash
git add src/main/ src/preload/index.ts
git commit -m "feat(m3): 回复管线(总线→触发→GLM→过滤→调度→页面发送)"
```

---

### Task 10: 设置 IPC + 设置抽屉 UI + AI 回复面板 UI

**Files:**
- Create: `src/renderer/src/components/ReplyPanel.vue`, `src/renderer/src/components/SettingsDrawer.vue`
- Modify: `src/renderer/src/App.vue`, `src/renderer/src/stores/settings.ts`(新建), `src/main/rooms/ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts`

- [ ] **Step 1: `shared/types.ts` 追加快照类型**

```ts
export interface ReplySnapshot {
  queue: ReplyTask[]
  history: ReplyTask[]
  sentLastMinute: number
  sentLastHour: number
}
```

- [ ] **Step 2: `src/main/rooms/ipc.ts` 追加设置 IPC（函数内追加）**

```ts
// registerRoomIpc 中追加（settings 实例由 index.ts 传入或在此加载）：
import { loadSettings } from '../settings'
const settings = loadSettings()

ipcMain.handle(IPC.settingsGet, () => settings.store)
ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
  settings.set(patch as never)
  return settings.store
})
```

（`AppSettings` 从 `'../settings'` import；`loadSettings()` 为幂等创建，若已在 index.ts 创建过会重复打开同一 store 文件——electron-store 多实例安全。）

- [ ] **Step 3: preload api 追加**

```ts
getSettings: (): Promise<AppSettingsLike> => ipcRenderer.invoke(IPC.settingsGet),
setSettings: (patch: Partial<AppSettingsLike>): Promise<AppSettingsLike> =>
  ipcRenderer.invoke(IPC.settingsSet, patch)
```

（`AppSettingsLike` 直接从 `../../src/main/settings` import `AppSettings` 类型并 re-export；`env.d.ts` 同步 import。）

- [ ] **Step 4: 写 `src/renderer/src/stores/settings.ts`**

```ts
import { defineStore } from 'pinia'
import type { AppSettings } from '../../../main/settings'

export const useSettingsStore = defineStore('settings', {
  state: () => ({ s: null as AppSettings | null }),
  actions: {
    async load() { this.s = await window.lda.getSettings() },
    async save(patch: Partial<AppSettings>) { this.s = await window.lda.setSettings(patch) },
    async toggleAi() {
      const enabled = await window.lda.toggleAi()
      if (this.s) this.s.aiEnabled = enabled
    }
  }
})
```

- [ ] **Step 5: 写 `ReplyPanel.vue`（回复队列/确认/弃用/表情气泡）**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ReplySnapshot } from '../../../shared/types'

const snap = ref<ReplySnapshot>({ queue: [], history: [], sentLastMinute: 0, sentLastHour: 0 })
const aiOn = ref(false)
const EMOTION_ICON: Record<string, string> = {
  answer: '💬', thanks: '🎁', greet: '👋', tease: '😜', comfort: '🫶'
}

onMounted(() => {
  window.lda.onReplyUpdate((s) => (snap.value = s))
})
</script>

<template>
  <div class="reply-panel">
    <div class="reply-head">
      <h3>🤖 AI 回复</h3>
      <button class="btn-cartoon" :class="{ 'ai-off': !aiOn }" @click="aiOn = !aiOn; window.lda.toggleAi()">
        {{ aiOn ? 'AI 已开启' : 'AI 已关闭' }}
      </button>
    </div>
    <p class="reply-stat">⚡ 已发送 {{ snap.sentLastMinute }}/分钟 · {{ snap.sentLastHour }}/小时</p>
    <div class="reply-scroll">
      <h4>待处理 / 队列（{{ snap.queue.length }}）</h4>
      <div v-for="t in snap.queue" :key="t.id" class="reply-card" :data-emotion="t.emotion">
        <div class="reply-text">{{ EMOTION_ICON[t.emotion] }} → {{ t.replyTo }}：{{ t.text }}</div>
        <div v-if="t.status === 'pending-confirm'" class="reply-actions">
          <button class="btn-cartoon" @click="window.lda.confirmReply(t.id)">✓ 发送</button>
          <button class="btn-cartoon reply-reject" @click="window.lda.rejectReply(t.id)">✗ 弃用</button>
        </div>
        <span v-else class="reply-status">{{ t.status }}</span>
      </div>
      <h4>历史（{{ snap.history.length }}）</h4>
      <div v-for="t in snap.history" :key="t.id" class="reply-card reply-card--done">
        <div class="reply-text">{{ EMOTION_ICON[t.emotion] }} {{ t.replyTo }}：{{ t.text }}</div>
        <div class="reply-actions" v-if="t.status === 'failed'">
          <button class="btn-cartoon" @click="window.lda.retryReply(t.id)">重试</button>
        </div>
        <span v-else class="reply-status">{{ t.status === 'sent' ? '✓' : t.status }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reply-panel { display: flex; flex-direction: column; height: 100%; padding: 12px; gap: 8px; }
.reply-head { display: flex; align-items: center; justify-content: space-between; }
.ai-off { background: #b9b9c9; }
.reply-stat { font-size: 12px; opacity: 0.7; }
.reply-scroll { overflow-y: auto; flex: 1; }
h4 { font-size: 12px; margin: 8px 0 4px; }
.reply-card { border: 2px solid var(--ink); border-radius: 6px; background: rgba(255,255,255,.7); padding: 8px; margin-bottom: 6px; font-size: 13px; }
.reply-card[data-emotion='thanks'] { background: var(--c-gift); }
.reply-card--done { opacity: 0.75; }
.reply-actions { display: flex; gap: 6px; margin-top: 6px; }
.reply-reject { background: #e05656; }
.reply-status { font-size: 11px; opacity: 0.6; }
</style>
```

- [ ] **Step 6: 写 `SettingsDrawer.vue` 并在 `App.vue` 挂载（顶栏⚙按钮打开）**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useSettingsStore } from '../stores/settings'

const store = useSettingsStore()
const open = ref(false)
const TRIGGERS = [
  { v: 'smart', label: '智能模式' }, { v: 'keyword', label: '关键词' },
  { v: 'question', label: '提问' }, { v: 'all', label: '全部回复(不推荐)' }
]

onMounted(() => void store.load())

async function save(): Promise<void> {
  if (!store.s) return
  await store.save({
    glmBaseUrl: store.s.glmBaseUrl, glmModel: store.s.glmModel, glmApiKey: store.s.glmApiKey,
    persona: store.s.persona, triggerMode: store.s.triggerMode,
    keywords: store.s.keywords, sensitiveWords: store.s.sensitiveWords,
    requireConfirm: store.s.requireConfirm, maxPerMinute: store.s.maxPerMinute,
    maxPerHour: store.s.maxPerHour
  })
  open.value = false
}
</script>

<template>
  <div>
    <button class="btn-cartoon" @click="open = true">⚙ 设置</button>
    <Teleport to="body">
      <div v-if="open" class="drawer-mask" @click.self="open = false">
        <div class="drawer glass-card">
          <h3>⚙ 设置</h3>
          <template v-if="store.s">
            <label>GLM BaseURL<input v-model="store.s.glmBaseUrl" class="input-cartoon" /></label>
            <label>模型<input v-model="store.s.glmModel" class="input-cartoon" /></label>
            <label>API Key（留空则使用 .env.local 的 Key）<input v-model="store.s.glmApiKey" class="input-cartoon" type="password" /></label>
            <label>人设 Prompt<textarea v-model="store.s.persona" class="input-cartoon" rows="3" /></label>
            <label>触发模式
              <select v-model="store.s.triggerMode" class="input-cartoon">
                <option v-for="t in TRIGGERS" :key="t.v" :value="t.v">{{ t.label }}</option>
              </select>
            </label>
            <label>关键词（逗号分隔）<input v-model="store.s.keywords.join(',')" @change="store.s.keywords = $event.target.value.split(',')" class="input-cartoon" /></label>
            <label>敏感词（逗号分隔）<input v-model="store.s.sensitiveWords.join(',')" @change="store.s.sensitiveWords = $event.target.value.split(',')" class="input-cartoon" /></label>
            <label>发送前人工确认 <input v-model="store.s.requireConfirm" type="checkbox" /></label>
            <label>每分钟上限 <input v-model.number="store.s.maxPerMinute" class="input-cartoon" type="number" min="1" max="5" /></label>
            <label>每小时上限 <input v-model.number="store.s.maxPerHour" class="input-cartoon" type="number" min="1" /></label>
            <div class="drawer-actions">
              <button class="btn-cartoon" @click="save">保存</button>
              <button class="btn-cartoon" @click="open = false">取消</button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.drawer-mask { position: fixed; inset: 0; background: rgba(43,43,58,.35); display: grid; place-items: center; }
.drawer { width: 460px; max-height: 85vh; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 10px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
.drawer-actions { display: flex; gap: 8px; }
</style>
```

`App.vue` 修改：顶栏的 `<button class="btn-cartoon topbar__settings" disabled>⚙ 设置(M3)</button>` 替换为 `<SettingsDrawer />`，并 import；右侧 `<section class="glass-card reply">` 整块替换为 `<ReplyPanel />`。

- [ ] **Step 7: 全链路手动冒烟**

Run: `npm run dev` → ⚙ 打开设置确认 Key 已从 `.env.local` 预填 → 添加 B 站直播间 → 开启 AI → 用小号在直播间发言提问 → Expected: 15~40 秒内回复面板出现待发任务；开启「人工确认」时点 ✓ 发送后直播间可见回复。

- [ ] **Step 8: Commit**

```bash
git add src/
git commit -m "feat(m3): AI回复面板/设置抽屉UI与设置IPC全链路"
```

---

### Task 11: SQLite 历史存储（批量落盘）

**Files:**
- Create: `src/main/db/store.ts`
- Modify: `package.json`, `src/main/index.ts`, `src/main/ai/pipeline.ts`
- Test: `tests/db-store.test.ts`（纯 Node `:memory:` 冒烟，Electron ABI 差异导致跳过时按 Step 4 处理）

- [ ] **Step 1: 安装依赖并重建原生模块**

```bash
npm install better-sqlite3@^11.10.0
npm install -D @electron/rebuild@^3.7.0
npx electron-rebuild -f -w better-sqlite3
```

- [ ] **Step 2: 实现 `src/main/db/store.ts`**

```ts
import Database from 'better-sqlite3'
import type { DanmakuMessage, ReplyTask } from '../shared/types'

export class DbStore {
  private db: Database.Database
  private buffer: DanmakuMessage[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(file: string) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS danmaku (
        id TEXT PRIMARY KEY, platform TEXT, room_id TEXT, type TEXT,
        uid TEXT, nickname TEXT, content TEXT, source TEXT, ts INTEGER
      );
      CREATE TABLE IF NOT EXISTS replies (
        id TEXT PRIMARY KEY, room_id TEXT, reply_to TEXT, text TEXT,
        emotion TEXT, status TEXT, created_at INTEGER, sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_danmaku_ts ON danmaku (ts);
    `)
    this.initStatements()
  }

  private stmtInsert: Database.Statement | null = null
  private stmtReply: Database.Statement | null = null

  private initStatements(): void {
    this.stmtInsert = this.db.prepare(
      `INSERT OR IGNORE INTO danmaku (id, platform, room_id, type, uid, nickname, content, source, ts)
       VALUES (@id, @platform, @roomId, @type, @uid, @nickname, @content, @source, @ts)`
    )
    this.stmtReply = this.db.prepare(
      `INSERT OR REPLACE INTO replies (id, room_id, reply_to, text, emotion, status, created_at, sent_at)
       VALUES (@id, @roomId, @replyTo, @text, @emotion, @status, @createdAt, @sentAt)`
    )
  }

  /** 弹幕入缓冲，每 2 秒事务批量写（热门房间限流写盘） */
  enqueueDanmaku(msg: DanmakuMessage): void {
    this.buffer.push(msg)
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), 2000)
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.buffer.length || !this.stmtInsert) return
    const rows = this.buffer.splice(0, this.buffer.length).map((m) => ({
      id: m.id, platform: m.platform, roomId: m.roomId, type: m.type,
      uid: m.user.uid, nickname: m.user.nickname, content: m.content, source: m.source, ts: m.ts
    }))
    const tx = this.db.transaction((list: unknown[]) => {
      for (const r of list) this.stmtInsert!.run(r)
    })
    tx(rows)
  }

  saveReply(t: ReplyTask): void {
    this.stmtReply?.run({
      id: t.id, roomId: t.roomId, replyTo: t.replyTo, text: t.text,
      emotion: t.emotion, status: t.status, createdAt: t.createdAt, sentAt: t.sentAt ?? null
    })
  }

  close(): void {
    this.flush()
    this.db.close()
  }
}
```

- [ ] **Step 3: 写测试 `tests/db-store.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { DbStore } from '../src/main/db/store'

describe('db store', () => {
  it('内存库批量写入与回复写入', () => {
    const store = new DbStore(':memory:')
    store.enqueueDanmaku({
      id: 'd1', platform: 'bilibili', roomId: '1', type: 'chat',
      user: { uid: 'u1', nickname: '小明' }, content: '你好', ts: 1, source: 'ws'
    })
    store.flush()
    store.saveReply({
      id: 'r1', roomId: '1', replyTo: '小明', text: '你好呀', emotion: 'greet',
      priority: 'normal', status: 'sent', createdAt: 2, sentAt: 3
    })
    // 经由内部句柄验证（导出只读方法亦可）：
    const rows = (store as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } })
      .db.prepare('SELECT * FROM danmaku').all()
    expect(rows).toHaveLength(1)
    store.close()
  })
})
```

Run: `npm test`
Expected: 若 vitest(Node ABI) 无法加载 Electron ABI 的 better-sqlite3，报 `ERR_DLOPEN` —— 此时**删除该测试文件**并在提交信息注明「db 验证走打包后手动冒烟」，继续后续步骤（这是已知 ABI 边界，不阻塞）。

- [ ] **Step 4: 接线（`src/main/index.ts` 与 `pipeline.ts`）**

`index.ts`（app ready 内）:
```ts
import { join } from 'path'
import { DbStore } from './db/store'
const db = new DbStore(join(app.getPath('userData'), 'danmaku.db'))
// app 'will-quit' 时 db.close()
app.on('will-quit', () => db.close())
```

`pipeline.ts` 的 `bus.on('danmaku')` 首行追加 `db.enqueueDanmaku(msg)`（db 经参数传入 `startReplyPipeline(win, settings, db)`）；调度器 `sender` 回调成功后 `db.saveReply({...task, status: 'sent'})`、失败后 `saveReply({...task, status: 'failed'})`。

- [ ] **Step 5: typecheck + Commit**

Run: `npm run typecheck` → exit 0

```bash
git add src/main/db/ src/main/index.ts src/main/ai/pipeline.ts tests/db-store.test.ts package.json package-lock.json
git commit -m "feat(m5): SQLite历史存储(WAL/批量落盘/回复留档)"
```

---

### Task 12: electron-builder 打包

**Files:**
- Create: `electron-builder.yml`
- Modify: `package.json`

- [ ] **Step 1: 写入 `electron-builder.yml`**

```yaml
appId: com.aesdnew.live-danmaku-assistant
productName: 直播弹幕助手
directories:
  output: release/${version}
files:
  - out/**
asarUnpack:
  - "**/*.node"
win:
  target: nsis
  artifactName: ${productName}-${version}-${arch}.${ext}
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: always
```

- [ ] **Step 2: `package.json` scripts 追加与 devDependencies**

```bash
npm install -D electron-builder@^25.1.0
```

```json
"scripts": {
  "dist": "electron-vite build && electron-builder --win nsis"
}
```

并在 `package.json` 顶层追加 `"main": "./out/main/index.js"`（若缺失）与：

```json
"build": { "electronDownload": { "mirror": "https://npmmirror.com/mirrors/electron/" } }
```

- [ ] **Step 3: 打包验证**

```bash
npm run dist
```
Expected: `release/` 产出安装包；安装后启动，添加 B 站房间 + AI 回复全链路可用（API Key 已由用户数据目录 electron-store 保存；开发机 `.env.local` 不打包，属预期——设置界面可填）。

- [ ] **Step 4: Commit**

```bash
git add electron-builder.yml package.json package-lock.json
git commit -m "feat(m5): electron-builder Windows NSIS打包配置"
```

---

## 验收标准（M3+M4+M5 完成时）

1. 挂 B 站房间 → AI 开启 → 观众提问/送礼 → 8~25 秒随机延迟后自动回复出现在直播间（或人工确认面板一键发送）。
2. 防风控生效：每分钟 ≤2 条（默认）、同文本 10 分钟去重、连续 3 次发送失败熔断 5 分钟。
3. 触发模式（智能/关键词/提问/全部）与敏感词库在设置抽屉即时生效。
4. 弹幕与回复落盘 SQLite（`%APPDATA%/直播弹幕助手/danmaku.db`）。
5. `npm test` 全绿（协议 5 + 映射 5 + schema 5 + client 3 + prompt 3 + trigger/filter 7 + scheduler 4 + env 2）；`npm run dist` 产出可安装包。
