import type { CaptureSource, DanmakuMessage, Platform } from '../../shared/types'
import { bilibiliAdapter } from './bilibili'
import { douyinAdapter } from './douyin'
import { douyuAdapter } from './douyu'
import { kuaishouAdapter } from './kuaishou'

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
  /** 注入页面主世界的抓取脚本 */
  injectScript(): string
  /** WS 长时间无数据时的 DOM 兜底脚本；平台未支持返回 null */
  domFallbackScript(): string | null
  /** 判断某个 WS 端点是否本平台的弹幕通道 */
  isDanmakuWs(url: string): boolean
  /** 解析一帧原始数据；无法识别时返回空 danmaku */
  parseFrame(raw: Buffer, roomId: string, source: CaptureSource): FrameResult
  /** 在页面内模拟输入并发送 */
  sendScript(text: string): string
}

const registry: Record<Platform, PlatformAdapter | null> = {
  bilibili: bilibiliAdapter,
  douyin: douyinAdapter,
  kuaishou: kuaishouAdapter,
  douyu: douyuAdapter
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
  if (t.includes('bilibili.com') || t.includes('b23.tv')) return 'bilibili'
  return null
}
