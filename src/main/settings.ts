import Store from 'electron-store'
import { app } from 'electron'
import type { AppSettings } from '../shared/types'
import { loadProjectEnv } from './envFile'

const DEFAULT_PERSONA =
  '你是主播的可爱助手「小糖」，性格活泼元气，说话简短口语化，喜欢用一点语气词，尊称观众为"宝子"。'

export const DEFAULT_SETTINGS: AppSettings = {
  glmBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  glmModel: 'glm-4.5-air',
  glmApiKey: '',
  persona: DEFAULT_PERSONA,
  triggerMode: 'smart',
  keywords: [],
  sensitiveWords: ['赌博', '刷单', '加微信', '兼职'],
  requireConfirm: true,
  maxPerMinute: 2,
  maxPerHour: 30,
  aiEnabled: false,
  // 相邻两条回复的间隔：8~25 秒随机（与 M4 调度器的原始取值一致）
  replyGapMinSec: 8,
  replyGapMaxSec: 25,
  // 「随机」模式的触发节奏：1~3 分钟随机一次
  randomIntervalMinSec: 60,
  randomIntervalMaxSec: 180,
  randomPoolSize: 20
}

let cachedEnvKey: string | null = null

/**
 * .env.local 里的 Key 只作为「兜底来源」按需读取，
 * 不写入 electron-store 默认值——否则会把明文 Key 复制进 settings.json。
 */
export function envApiKey(): string {
  if (cachedEnvKey === null) cachedEnvKey = loadProjectEnv(app.getAppPath())['ZHIPU_API_KEY'] ?? ''
  return cachedEnvKey
}

export function hasApiKey(settings: Store<AppSettings>): boolean {
  return Boolean(settings.get('glmApiKey') || envApiKey())
}

/** 优先级：设置里显式填写的 Key > .env.local */
export function effectiveApiKey(settings: Store<AppSettings>): string {
  return settings.get('glmApiKey') || envApiKey()
}

/** 幂等：多次调用返回同一份配置文件（electron-store 多实例安全） */
export function loadSettings(): Store<AppSettings> {
  return new Store<AppSettings>({ name: 'settings', defaults: { ...DEFAULT_SETTINGS } })
}
