export interface GlmConfig {
  /** 允许传入 getter，使配置随设置实时刷新 */
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

const RETRIES = 2
const BACKOFF_MS = [1500, 4000]

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

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
        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>
        }
        return JSON.parse(data.choices?.[0]?.message?.content ?? '{}')
      } catch (err) {
        lastErr = err as Error
        if (attempt < RETRIES) await sleep(BACKOFF_MS[attempt])
      }
    }
    throw lastErr ?? new Error('GLM request failed')
  }
}
