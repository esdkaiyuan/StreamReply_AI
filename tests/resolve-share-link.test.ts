import { describe, expect, it, vi } from 'vitest'
import { followRedirect } from '../src/main/net/resolveShareLink'

function fakeFetch(finalUrl: string | Error, opts: { status?: number } = {}) {
  return vi.fn(async () => {
    if (finalUrl instanceof Error) throw finalUrl
    return { url: finalUrl, status: opts.status ?? 200 } as unknown as Response
  }) as unknown as typeof fetch
}

describe('分享短链跳转解析', () => {
  it('跳到最终地址后返回它', async () => {
    const impl = fakeFetch('https://live.douyin.com/802353522320')
    expect(await followRedirect('https://v.douyin.com/AbCdEf/', { fetchImpl: impl })).toBe(
      'https://live.douyin.com/802353522320'
    )
  })

  it('请求失败时返回原值，不抛异常（不能因网络抖动把添加房间搞崩）', async () => {
    const impl = fakeFetch(new Error('network down'))
    expect(await followRedirect('https://v.douyin.com/x/', { fetchImpl: impl })).toBe(
      'https://v.douyin.com/x/'
    )
  })

  it('不是 http(s) 的输入直接返回，不发请求', async () => {
    const impl = fakeFetch('https://example.com/')
    expect(await followRedirect('802353522320', { fetchImpl: impl })).toBe('802353522320')
    expect(impl).not.toHaveBeenCalled()
  })

  it('响应没有 url 字段时保留原值', async () => {
    const impl = vi.fn(async () => ({ status: 200 })) as unknown as typeof fetch
    expect(await followRedirect('https://v.douyin.com/y/', { fetchImpl: impl })).toBe(
      'https://v.douyin.com/y/'
    )
  })

  it('超时会中止请求并返回原值', async () => {
    const impl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    ) as unknown as typeof fetch

    const result = await followRedirect('https://v.douyin.com/z/', {
      fetchImpl: impl,
      timeoutMs: 20
    })
    expect(result).toBe('https://v.douyin.com/z/')
  })
})
