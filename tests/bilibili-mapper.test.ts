import { describe, expect, it } from 'vitest'
import type { DanmakuMessage } from '../src/shared/types'
import { mapBilibiliEvent } from '../src/main/adapters/bilibili/mapper'

describe('bilibili mapper', () => {
  it('DANMU_MSG 带 cmd 后缀也能映射为 chat', () => {
    const msg = mapBilibiliEvent(
      'DANMU_MSG:4:0:2:2:2:0:123',
      [
        [], '主播好呀',
        [12345, '小明', 'https://i0.hdslb.com/a.jpg', 0, 0, 0, '', 0],
        ['粉丝团', 21]
      ],
      '10086',
      'ws'
    ) as DanmakuMessage | null
    expect(msg).not.toBeNull()
    expect(msg!.type).toBe('chat')
    expect(msg!.content).toBe('主播好呀')
    expect(msg!.user.uid).toBe('12345')
    expect(msg!.user.nickname).toBe('小明')
    expect(msg!.user.avatar).toBe('https://i0.hdslb.com/a.jpg')
    expect(msg!.user.guardLevel).toBe(21)
    expect(msg!.source).toBe('ws')
  })

  it('INTERACT_WORD 映射为 enter', () => {
    const msg = mapBilibiliEvent(
      'INTERACT_WORD',
      { data: { uid: 7, uname: '路过的小王', fans_medal: { target_id: 0 } } },
      '10086',
      'ws'
    ) as DanmakuMessage | null
    expect(msg!.type).toBe('enter')
    expect(msg!.user.nickname).toBe('路过的小王')
  })

  it('SEND_GIFT 映射为 gift 且含礼物信息', () => {
    const msg = mapBilibiliEvent(
      'SEND_GIFT',
      { data: { uid: 8, uname: '土豪哥', giftName: '小花花', num: 10, price: 100, face: '' } },
      '10086',
      'ws'
    ) as DanmakuMessage | null
    expect(msg!.type).toBe('gift')
    expect(msg!.gift).toEqual({ name: '小花花', count: 10, price: 1 })
  })

  it('WATCHED_CHANGE 返回 RoomStatEvent', () => {
    const stat = mapBilibiliEvent('WATCHED_CHANGE', { data: { num: 233 } }, '10086', 'ws')
    expect(stat).not.toBeNull()
    expect((stat as any).onlineCount).toBe(233)
  })

  it('未知 cmd 返回 null', () => {
    expect(mapBilibiliEvent('SOMETHING_ELSE', {}, '10086', 'ws')).toBeNull()
  })
})
