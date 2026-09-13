import { readFileSync } from 'fs'
import { join } from 'path'

/** 解析项目根 .env.local（Key 私有配置，gitignore 排除） */
export function parseEnvFile(content: string | null): Record<string, string> {
  if (!content) return {}
  const env: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

export function loadProjectEnv(appPath: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(join(appPath, '.env.local'), 'utf8'))
  } catch {
    return {}
  }
}
