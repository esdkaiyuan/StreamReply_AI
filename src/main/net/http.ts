import { net, session, type Session } from 'electron'

/**
 * 统一 HTTP 层。
 *
 * ⚠️ 本机环境实测：Chromium 网络栈（`net.fetch` / `ses.fetch`）与 Node 原生 `fetch`
 * 会**各自独立地偶发失败**（`net::ERR_BLOCKED_BY_CLIENT` / `ERR_CONNECTION_CLOSED` /
 * `fetch failed`），任一单栈都会让上层无谓降级。故统一在此做双栈兜底。
 *
 * 另：需要写 Cookie 的场景（登录）优先走会话栈以便自动落库，
 * 同时把 `Set-Cookie` 显式取出来，供调用方手动写入会话（Node 栈不会自动落库）。
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export interface HttpRequest {
  url: string
  referer?: string
  /** 指定会话：带上该会话的 Cookie，且响应 Cookie 会自动写入该会话 */
  session?: Session | null
}

export interface HttpResponse {
  json: unknown
  /** `Set-Cookie` 原文列表（Node 栈下不会自动落库，需调用方处理） */
  setCookie: string[]
  status: number
}

let loggedFallback = false

/** 取会话中对该 URL 生效的 Cookie，拼成请求头 */
async function sessionCookieHeader(ses: Session, url: string): Promise<string> {
  try {
    const list = await ses.cookies.get({ url })
    return list.map((c) => `${c.name}=${c.value}`).join('; ')
  } catch {
    return ''
  }
}

function readSetCookie(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof withGetter.getSetCookie === 'function') {
    try {
      return withGetter.getSetCookie()
    } catch {
      /* 某些实现会抛，退化为整体读取 */
    }
  }
  const raw = headers.get('set-cookie')
  return raw ? [raw] : []
}

async function runFetch(
  input: string,
  init: RequestInit & { session?: Session }
): Promise<HttpResponse> {
  const res = init.session ? await init.session.fetch(input, init) : await net.fetch(input, init)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const setCookie = readSetCookie(res.headers)
  return { json: (await res.json()) as unknown, setCookie, status: res.status }
}

export async function httpRequest(req: HttpRequest): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json'
  }
  if (req.referer) headers['Referer'] = req.referer

  const ses = req.session === undefined ? null : req.session
  const attempts: Array<() => Promise<HttpResponse>> = []
  if (ses) attempts.push(() => runFetch(req.url, { headers, session: ses }))
  else attempts.push(() => runFetch(req.url, { headers }))
  /**
   * 兜底栈：Node 原生 fetch（不走 Chromium 网络栈）。
   * ⚠️ 该栈**不会自动带会话 Cookie**——本机网络服务会崩溃重启，此时若不带 Cookie，
   * 需要登录态的接口（如 nav）会一律返回「未登录」，导致误判。
   * 故这里显式把会话 Cookie 拼进请求头。
   */
  attempts.push(async () => {
    const fallbackHeaders = { ...headers }
    if (ses) {
      const cookie = await sessionCookieHeader(ses, req.url)
      if (cookie) fallbackHeaders['Cookie'] = cookie
    }
    const res = await fetch(req.url, { headers: fallbackHeaders })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { json: (await res.json()) as unknown, setCookie: readSetCookie(res.headers), status: res.status }
  })

  let lastError: unknown
  for (let i = 0; i < attempts.length; i++) {
    try {
      const result = await attempts[i]!()
      if (i > 0 && !loggedFallback) {
        loggedFallback = true
        console.warn('[http] Chromium 网络栈不可用，已切换到 Node 网络栈：', String(lastError))
      }
      return result
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(String(lastError))
}

/** 只取 JSON 的便捷封装（直连抓取用） */
export async function httpJson<T = unknown>(url: string, referer?: string): Promise<T> {
  const res = await httpRequest({ url, referer })
  return res.json as T
}

/** 默认会话（主窗口、隐藏 WebView 共用同一会话，登录一次全局生效） */
export function defaultSession(): Session {
  return session.defaultSession
}
