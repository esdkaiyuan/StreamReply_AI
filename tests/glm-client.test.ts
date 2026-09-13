import { afterEach, describe, expect, it, vi } from 'vitest'
import { GlmClient } from '../src/main/ai/client'

function okResponse(): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{"action":"ignore"}' } }] })
  }
}

describe('glm client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('POST chat/completions 并返回 content', async () => {
    const fetchMock = vi.fn(async () => okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const client = new GlmClient({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'k-test',
      model: 'glm-4.5-air'
    })
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

  it('500 后退避重试并成功', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce(okResponse())
    vi.stubGlobal('fetch', fetchMock)
    const client = new GlmClient({ baseUrl: 'https://x/v4', apiKey: 'k', model: 'glm-4.5-air' })
    const p = client.chatJson('s', 'u')
    await vi.runAllTimersAsync()
    expect(await p).toEqual({ action: 'ignore' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('重试耗尽抛出错误', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new GlmClient({ baseUrl: 'https://x/v4', apiKey: 'k', model: 'glm-4.5-air' })
    const assertion = expect(client.chatJson('s', 'u')).rejects.toThrow('GLM request failed: 429')
    await vi.runAllTimersAsync()
    await assertion
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
