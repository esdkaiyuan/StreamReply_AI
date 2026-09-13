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
