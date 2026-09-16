const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export interface FollowRedirectDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * 跟随重定向拿到最终 URL。
 *
 * 用途：抖音 / 快手的「分享短链」（`v.douyin.com/xxx`、`v.kuaishou.com/xxx`）里
 * **不含房间号**，必须跳转后才能拿到真实地址。离线解析只能是猜，所以老老实实发一次请求。
 *
 * 失败一律**返回原 URL**（不抛异常）：解析不出房间号时上层会给出明确的「无法解析」提示，
 * 比因为网络抖动而崩掉添加流程要好。
 */
export async function followRedirect(
  url: string,
  deps: FollowRedirectDeps = {}
): Promise<string> {
  const target = String(url ?? '').trim()
  if (!/^https?:\/\//i.test(target)) return target

  const impl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? 8000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await impl(target, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }
    })
    return res.url || target
  } catch {
    return target
  } finally {
    clearTimeout(timer)
  }
}
