import { createHash } from 'node:crypto'

/**
 * B 站 WBI 签名。
 *
 * 背景：`getDanmuInfo` 等接口在缺少有效签名时返回 `-352（风控校验失败）`，
 * 实测（2026-09-15）加签名后返回 `code=0` 并给出 token + 弹幕服务器列表。
 *
 * 算法为公开固定值：取 `nav` 接口的 wbi_img（img_url / sub_url）文件名拼接，
 * 按混淆表重排后取前 32 位作为 mixinKey，再对排序后的查询串做 MD5。
 */

/** 混淆表（B 站前端固定值，公开算法） */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
  28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
  54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
]

/** 从 URL 末段取出不带扩展名的文件名（如 `.../7cd084.png` → `7cd084`） */
function fileName(url: string): string {
  const last = url.split('/').pop() ?? ''
  return last.split('.')[0] ?? ''
}

/** img_url + sub_url → 32 位 mixinKey */
export function getMixinKey(imgUrl: string, subUrl: string): string {
  const raw = fileName(imgUrl) + fileName(subUrl)
  let out = ''
  for (const i of MIXIN_TAB) out += raw[i] ?? ''
  return out.slice(0, 32)
}

/**
 * 生成已签名的查询串（含 `w_rid`）。
 * `wts` 由调用方显式传入：既保证同一秒内多次调用签名一致，也便于单测固定断言。
 */
export function signWbi(
  params: Record<string, string | number>,
  mixinKey: string,
  wts: number
): string {
  const all: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      // B 站前端会先剔除 !'()* 这几个字符再编码
      const value = String(all[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const rid = createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${rid}`
}
