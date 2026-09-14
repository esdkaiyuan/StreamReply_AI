/**
 * 斗鱼 STT 序列化格式（斗鱼自定义，非 JSON/XML）：
 * - 键值对：`key@=value`
 * - 字段之间用 `/` 分隔
 * - 转义：`/` 写作 `@S`，`@` 写作 `@A`
 *
 * 解码顺序很关键：必须先把 `@S` 还原成 `/`，再把 `@A` 还原成 `@`。
 * 反了就会把原本就是 `@S` 的文本误变成 `/`。
 */

/** 把一段 STT 文本解析成键值对；坏数据返回已解析部分，绝不抛异常 */
export function parseStt(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  const text = body.replace(/\0+$/, '')
  if (!text) return out
  for (const field of text.split('/')) {
    if (!field) continue
    const eq = field.indexOf('@=')
    if (eq <= 0) continue
    const key = field.slice(0, eq)
    const raw = field.slice(eq + 2)
    out[key] = raw.replace(/@S/g, '/').replace(/@A/g, '@')
  }
  return out
}

/** 字段值转义（发送侧需要，测试也用它构造报文） */
export function escapeSttValue(value: string): string {
  return value.replace(/@/g, '@A').replace(/\//g, '@S')
}

export function serializeStt(fields: Record<string, string | number>): string {
  return (
    Object.entries(fields)
      .map(([k, v]) => `${k}@=${escapeSttValue(String(v))}`)
      .join('/') + '/'
  )
}
