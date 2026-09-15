import { describe, expect, it } from 'vitest'
import {
  hasSessionCookie,
  parseCookieInput,
  parseCookiePairs
} from '../src/main/auth/cookie'

describe('Cookie 串解析', () => {
  it('解析浏览器面板常见的分号串', () => {
    const pairs = parseCookieInput('SESSDATA=abc123; bili_jct=token; DedeUserID=9527')
    expect(pairs).toEqual([
      { name: 'SESSDATA', value: 'abc123' },
      { name: 'bili_jct', value: 'token' },
      { name: 'DedeUserID', value: '9527' }
    ])
  })

  it('容忍换行与 `Cookie:` 前缀', () => {
    const pairs = parseCookieInput('Cookie: SESSDATA=abc\nbili_jct=def\n')
    expect(pairs.map((p) => p.name)).toEqual(['SESSDATA', 'bili_jct'])
  })

  it('丢弃 Path/Domain 等属性段，只保留 name=value', () => {
    const pairs = parseCookieInput('SESSDATA=abc; Path=/; Domain=.bilibili.com; Secure')
    expect(pairs).toEqual([{ name: 'SESSDATA', value: 'abc' }])
  })

  it('值里含 = 时按首个等号切分', () => {
    const pairs = parseCookieInput('SESSDATA=aGVsbG8%3D%3D; bili_jct=x')
    expect(pairs[0]).toEqual({ name: 'SESSDATA', value: 'aGVsbG8%3D%3D' })
  })

  it('忽略空段与非法段', () => {
    expect(parseCookieInput('; ; =novalue; ok=1 ;')).toEqual([{ name: 'ok', value: '1' }])
  })

  it('空输入返回空数组', () => {
    expect(parseCookieInput('')).toEqual([])
    expect(parseCookieInput('   ')).toEqual([])
  })

  it('Set-Cookie 原文取首段', () => {
    const pairs = parseCookiePairs([
      'SESSDATA=xyz; Path=/; HttpOnly; Expires=Wed, 21 Oct 2026 07:28:00 GMT',
      'bili_jct=tok; Path=/'
    ])
    expect(pairs).toEqual([
      { name: 'SESSDATA', value: 'xyz' },
      { name: 'bili_jct', value: 'tok' }
    ])
  })

  it('缺少 SESSDATA 时判定为不可登录', () => {
    expect(hasSessionCookie(parseCookieInput('bili_jct=only'))).toBe(false)
    expect(hasSessionCookie(parseCookieInput('SESSDATA='))).toBe(false)
    expect(hasSessionCookie(parseCookieInput('SESSDATA=abc'))).toBe(true)
  })
})
