import { describe, expect, it } from 'vitest'
import { parseEnvFile } from '../src/main/envFile'

describe('env file parser', () => {
  it('解析 KEY=VALUE 并忽略注释/空行', () => {
    const env = parseEnvFile('# 注释\nA=1\n\nB=hello world\n')
    expect(env).toEqual({ A: '1', B: 'hello world' })
  })
  it('损坏内容返回空对象', () => {
    expect(parseEnvFile(null)).toEqual({})
  })
})
