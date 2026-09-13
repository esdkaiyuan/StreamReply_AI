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
