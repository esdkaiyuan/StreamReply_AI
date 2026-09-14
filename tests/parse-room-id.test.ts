import { describe, expect, it } from 'vitest'
import { parseKuaishouRoomId, parseNumericRoomId as parseRoomId } from '../src/main/adapters/roomId'

describe('parseRoomId', () => {
  it('纯数字长房间号直取', () => {
    expect(parseRoomId('21452525')).toBe('21452525')
  })

  it('纯数字短房间号（1-3位）也接受', () => {
    expect(parseRoomId('920')).toBe('920')
  })

  it('URL 带查询参数时取路径数字段，不误取参数', () => {
    expect(parseRoomId('https://live.bilibili.com/6?visit_id=8h2k3l4')).toBe('6')
  })

  it('URL 无查询参数取路径数字段', () => {
    expect(parseRoomId('live.bilibili.com/21452525')).toBe('21452525')
  })

  it('URL 末尾带斜杠仍可解析', () => {
    expect(parseRoomId('https://live.bilibili.com/12345/')).toBe('12345')
  })

  it('自由文本兜底取 4 位以上数字串', () => {
    expect(parseRoomId('房间号 21013423 快来')).toBe('21013423')
  })

  it('无数字返回 null', () => {
    expect(parseRoomId('hello world')).toBeNull()
    expect(parseRoomId('   ')).toBeNull()
  })
})

describe('快手房间号', () => {
  it('/u/ 段取 principalId', () => {
    expect(parseKuaishouRoomId('https://live.kuaishou.com/u/3x7abcDEF')).toBe('3x7abcDEF')
  })

  it('裸 alphanumeric ID 直取', () => {
    expect(parseKuaishouRoomId('3x7abcDEF')).toBe('3x7abcDEF')
  })

  it('分享短链无法离线解析，返回 null 而不是瞎猜', () => {
    expect(parseKuaishouRoomId('https://v.kuaishou.com/AbC')).toBeNull()
  })

  it('B 站 URL 不会被误判为快手 ID', () => {
    expect(parseKuaishouRoomId('https://live.bilibili.com/21452525')).toBeNull()
  })
})
