import type { CaptureSource, DanmakuMessage, Platform } from '../../shared/types'
import { bilibiliAdapter } from './bilibili'
import type { DirectClient, DirectHooks } from './bilibili/directClient'
import { douyinAdapter } from './douyin'
import { douyuAdapter } from './douyu'
import { huyaAdapter } from './huya'
import { kuaishouAdapter } from './kuaishou'

export type { DirectClient, DirectHooks } from './bilibili/directClient'

export interface FrameResult {
  danmaku: DanmakuMessage[]
  /** 帧里带在线人数时回填，由上层换算成 RoomStatEvent */
  onlineCount?: number
}

/** 平台适配器统一接口：新增平台只需实现这个接口并注册 */
export interface PlatformAdapter {
  readonly platform: Platform
  roomUrl(roomId: string): string
  /** 从用户输入解析本平台的房间号 */
  parseRoomId(input: string): string | null
  /**
   * 输入前置归一化（可选，**允许发网络请求**）。
   * 典型场景：抖音/快手的「分享短链」里不含房间号，必须先跳转才能拿到真实地址。
   */
  normalizeInput?(input: string): Promise<string>
  /** 注入页面主世界的抓取脚本 */
  injectScript(): string
  /**
   * 进房间前的**预热地址**（可选）。
   *
   * 有些平台直接打开房间页会被服务端/前端判定为异常（302 到错误页），
   * 需要先访问一次站点首页建立会话。虎牙实测：直接进房间页会被换掉，
   * 先访首页再进房间即正常。
   */
  warmupUrl?(): string
  /** WS 长时间无数据时的 DOM 兜底脚本；平台未支持返回 null */
  domFallbackScript(): string | null
  /** 判断某个 WS 端点是否本平台的弹幕通道 */
  isDanmakuWs(url: string): boolean
  /** 解析一帧原始数据；无法识别时返回空 danmaku */
  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult
  /** 在页面内模拟输入并发送 */
  sendScript(text: string): string
  /**
   * 发送前的平台准备工作（可选）。
   *
   * B 站用它补全发送必需的 CSRF Cookie（`bili_jct`）——缺它会「能收弹幕但发不出」
   * （服务端 -111），而页面脚本仍会返回成功，是个很难自证的假成功。
   * 放在适配器里而不是通用发送路径，是为了不把平台细节渗进 webviewManager。
   */
  prepareSend?(): Promise<void>
  /**
   * 抓取改用 CDP 网络事件（`webContents.debugger` + Network 域）。
   *
   * 适合「连接建在 Worker / 内部实现里」的平台（实测 B 站就是这样，抖音同理）——
   * CDP 事件是浏览器进程级的，Worker 内的连接一样能看到。
   * 开启后**不再注入页面 hook**，避免同一批弹幕被两个来源各发一遍。
   */
  captureViaCdp?: boolean
  /**
   * HTTP 推流端点判定（可选）。
   * 目前仅用于**诊断上报**：命中并持续分片时会在日志里提示，
   * 便于确认真实环境到底走 WebSocket 还是 fetch 流（流式重组待实测后再落地）。
   */
  isDanmakuStream?(url: string, mimeType: string): boolean
  /**
   * 主进程直连抓取（不依赖页面传输层）。返回 null 表示平台不支持。
   * 支持时优先于页面注入路径，用于绕开「连接建在 Worker 内」等场景。
   */
  createDirectCapture?(roomId: string, hooks: DirectHooks): Promise<DirectClient | null>
}

const registry: Record<Platform, PlatformAdapter | null> = {
  bilibili: bilibiliAdapter,
  douyin: douyinAdapter,
  kuaishou: kuaishouAdapter,
  douyu: douyuAdapter,
  huya: huyaAdapter
}

export function getAdapter(platform: Platform): PlatformAdapter | null {
  return registry[platform] ?? null
}

export function listSupportedPlatforms(): Platform[] {
  return (Object.keys(registry) as Platform[]).filter((p) => registry[p] !== null)
}

/**
 * 从用户输入识别平台：能识别 URL 域名的直接返回，裸房间号返回 null，
 * 由调用方按用户所选平台兜底（默认 B 站，保持一期行为）。
 */
export function detectPlatform(input: string): Platform | null {
  const t = input.toLowerCase()
  if (t.includes('douyin.com')) return 'douyin'
  if (t.includes('kuaishou.com')) return 'kuaishou'
  if (t.includes('douyu.com')) return 'douyu'
  if (t.includes('huya.com')) return 'huya'
  if (t.includes('bilibili.com') || t.includes('b23.tv')) return 'bilibili'
  return null
}
