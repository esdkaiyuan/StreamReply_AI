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
  aiEnabled: false
}

/** 幂等：多次调用返回同一份配置文件（electron-store 多实例安全）。Key 默认取 .env.local */
export function loadSettings(): Store<AppSettings> {
  const env = loadProjectEnv(app.getAppPath())
  return new Store<AppSettings>({
    name: 'settings',
    defaults: { ...DEFAULT_SETTINGS, glmApiKey: env['ZHIPU_API_KEY'] ?? '' }
  })
}
