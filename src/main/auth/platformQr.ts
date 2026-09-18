/**
 * 平台原生二维码登录实现：快手 / 斗鱼（接口均来自官方登录页抓包实测）。
 *
 * 快手（2026-09-19 实测）：
 *   generate: POST id.kuaishou.com/rest/c/infra/ks/qr/start
 *             body: sid=kuaishou.server.webday7&channelType=UNKNOWN&isWebSig4=true
 *             → { result:1, qrUrl:"http://qr.kuaishou.com/l/<token>", qrLoginSignature, imageData(base64 PNG), expireTime }
 *   poll:     POST id.kuaishou.com/rest/c/infra/ks/qr/scanResult
 *             body: qrLoginToken=<token>&qrLoginSignature=<sig>&channelType=UNKNOWN&isWebSig4=true
 *             → result: 707=二维码过期；成功时 Set-Cookie 落会话
 *   ⚠️ 二维码有效期仅 ~59 秒，UI 需要自动刷新
 *
 * 斗鱼（2026-09-19 实测）：
 *   generate: POST passport.douyu.com/scan/generateCode  body: client_id=1&isMultiAccount=0
 *             → { error:0, data:{ url(二维码内容), code, expire:300 } }
 *   poll:     GET  passport.douyu.com/japi/scan/auth?time=<ts>&code=<code>
 *             → { error, data }；成功时 Set-Cookie 落会话（error 码语义待真机扫码验证）
 *
 * 所有请求走 defaultSession（ses.fetch），Set-Cookie 自动落库 → saveCurrentAccount 直接可用。
 */
import { session } from 'electron'
import QRCode from 'qrcode'
import type { Platform, QrPollResult, QrSession } from '../../shared/types'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export interface PlatformQrResult {
  ok: boolean
  session?: QrSession
  error?: string
}

/** key 里编码平台的轮询凭证（格式: <platform>:<token>|<signature>），poll 时拆开用 */
function packKey(platform: Platform, token: string, sig: string): string {
  return `${platform}:${token}|${sig}`
}

function unpackKey(key: string): { platform: Platform; token: string; sig: string } | null {
  const colon = key.indexOf(':')
  const pipe = key.indexOf('|')
  if (colon < 0 || pipe < colon) return null
  return { platform: key.slice(0, colon) as Platform, token: key.slice(colon + 1, pipe), sig: key.slice(pipe + 1) }
}

async function postForm(url: string, body: string, referer: string): Promise<{ status: number; json: any; setCookie: string[] }> {
  const res = await session.defaultSession.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: `https://${new URL(url).hostname.replace(/^id\./, 'www.').replace(/^passport\./, 'www.')}`,
      Referer: referer,
      'User-Agent': UA
    },
    body
  })
  return { status: res.status, json: await res.json().catch(() => null), setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : [] }
}

// ---------------- 快手 ----------------

async function ksGenerate(): Promise<PlatformQrResult> {
  const r = await postForm(
    'https://id.kuaishou.com/rest/c/infra/ks/qr/start',
    'sid=kuaishou.server.webday7&channelType=UNKNOWN&isWebSig4=true',
    'https://www.kuaishou.com/'
  )
  const j = r.json
  if (r.status !== 200 || !j || j.result !== 1 || !j.imageData) {
    return { ok: false, error: `快手二维码生成失败：${j?.error_msg ?? j?.result ?? r.status}` }
  }
  const token = String(j.qrUrl || '').split('/l/')[1] || ''
  return {
    ok: true,
    session: {
      // imageData 本身就是官方渲染的二维码 PNG
      qrDataUrl: `data:image/png;base64,${j.imageData}`,
      key: packKey('kuaishou', token, String(j.qrLoginSignature ?? '')),
      // ⚠️ 快手二维码有效期实测 ~59 秒
      expiresAt: Number(j.expireTime) || Date.now() + 60_000
    }
  }
}

async function ksPoll(key: string): Promise<QrPollResult> {
  const k = unpackKey(key)
  if (!k) return { phase: 'error', message: '轮询凭证损坏，请重新生成二维码' }
  const r = await postForm(
    'https://id.kuaishou.com/rest/c/infra/ks/qr/scanResult',
    `qrLoginToken=${encodeURIComponent(k.token)}&qrLoginSignature=${encodeURIComponent(k.sig)}&channelType=UNKNOWN&isWebSig4=true`,
    'https://www.kuaishou.com/'
  )
  const j = r.json
  if (!j) return { phase: 'error', message: `网络异常（${r.status}）` }
  if (j.result === 707) return { phase: 'expired', message: '二维码已过期（快手有效期约 1 分钟），请重新生成' }
  if (j.result !== 0 && !j.data) {
    // 未实测到「等待/已扫」的确定码：非 0 非 707 一律按等待处理，UI 每 2 秒会再轮询
    return { phase: 'waiting-scan', message: `等待扫码中（code=${j.result}）` }
  }
  // result=0：登录成功，Set-Cookie 已由会话落库
  return { phase: 'confirmed' }
}

// ---------------- 斗鱼 ----------------

async function dyGenerate(): Promise<PlatformQrResult> {
  const r = await postForm(
    'https://passport.douyu.com/scan/generateCode',
    'client_id=1&isMultiAccount=0',
    'https://www.douyu.com/'
  )
  const j = r.json
  if (r.status !== 200 || !j || j.error !== 0 || !j.data?.url) {
    return { ok: false, error: `斗鱼二维码生成失败：${j?.msg ?? j?.error ?? r.status}` }
  }
  const qrDataUrl = await QRCode.toDataURL(j.data.url, { margin: 1, width: 240 })
  return {
    ok: true,
    session: {
      qrDataUrl,
      key: packKey('douyu', String(j.data.code), ''),
      expiresAt: Date.now() + (Number(j.data.expire) || 300) * 1000
    }
  }
}

async function dyPoll(key: string): Promise<QrPollResult> {
  const k = unpackKey(key)
  if (!k) return { phase: 'error', message: '轮询凭证损坏，请重新生成二维码' }
  const url = `https://passport.douyu.com/japi/scan/auth?time=${Date.now()}&code=${encodeURIComponent(k.token)}`
  const res = await session.defaultSession.fetch(url, {
    headers: { Referer: 'https://www.douyu.com/', 'User-Agent': UA }
  })
  const j = await res.json().catch(() => null)
  if (!j) return { phase: 'error', message: `网络异常（${res.status}）` }
  // 斗鱼的 error 码语义（等待/已扫）未完整实测：0 且带 data 视为成功，其它按等待轮询
  if (j.error === 0 && j.data && typeof j.data === 'object' && Object.keys(j.data).length > 0) {
    return { phase: 'confirmed' }
  }
  return { phase: 'waiting-scan', message: `等待扫码中（error=${j.error ?? '?'}）` }
}

// ---------------- 分发 ----------------

const GENERATORS: Partial<Record<Platform, () => Promise<PlatformQrResult>>> = {
  kuaishou: ksGenerate,
  douyu: dyGenerate
}

const POLLERS: Partial<Record<Platform, (key: string) => Promise<QrPollResult>>> = {
  kuaishou: ksPoll,
  douyu: dyPoll
}

/** 生成某平台的登录二维码；未实现的平台返回 not-supported（UI 回落官方登录窗口） */
export async function platformQrGenerate(platform: Platform): Promise<PlatformQrResult> {
  const gen = GENERATORS[platform]
  if (!gen) return { ok: false, error: 'not-supported' }
  try {
    return await gen()
  } catch (err) {
    return { ok: false, error: String(err).replace(/^Error:\s*/, '') }
  }
}

/** 轮询某平台的扫码状态；confirmed 时 Set-Cookie 已落在会话中（调用方负责保存账号） */
export async function platformQrPoll(platform: Platform, key: string): Promise<QrPollResult> {
  const poll = POLLERS[platform]
  if (!poll) return { phase: 'error', message: 'not-supported' }
  try {
    return await poll(key)
  } catch (err) {
    return { phase: 'error', message: String(err).replace(/^Error:\s*/, '') }
  }
}
