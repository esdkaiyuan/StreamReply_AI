import { describe, expect, it } from 'vitest'
import { bilibiliAdapter } from '../src/main/adapters/bilibili'
import { douyinAdapter } from '../src/main/adapters/douyin'
import { detectPlatform, getAdapter, listSupportedPlatforms } from '../src/main/adapters'
import { OP, buildPacket } from '../src/main/adapters/bilibili/protocol'

describe('platform detection', () => {
  it('按域名识别，裸房间号返回 null', () => {
    expect(detectPlatform('https://live.douyin.com/123456')).toBe('douyin')
    expect(detectPlatform('https://live.bilibili.com/22637261')).toBe('bilibili')
    expect(detectPlatform('https://live.kuaishou.com/u/abc')).toBe('kuaishou')
    expect(detectPlatform('22637261')).toBeNull()
  })

  it('已实现适配器的平台清单不含快手', () => {
    expect(listSupportedPlatforms()).toEqual(['bilibili', 'douyin'])
    expect(getAdapter('kuaishou')).toBeNull()
    expect(getAdapter('douyin')).not.toBeNull()
  })
})

describe('bilibili adapter（重构回归）', () => {
  it('DANMU_MSG 帧仍解析为 chat 弹幕', () => {
    const body = Buffer.from(
      JSON.stringify({
        cmd: 'DANMU_MSG',
        info: [
          [0, 1, 25, 16777215, 1e12, 0, 0, '', 0, 0, 0],
          '重构后依然能解析',
          [12345, '小明', 0, 0, 0, 10000, 1, ''],
          [],
          []
        ]
      })
    )
    const frame = buildPacket(OP.MESSAGE, 0, body)
    const result = bilibiliAdapter.parseFrame(frame, '22637261', 'ws')
    expect(result.danmaku).toHaveLength(1)
    const first = result.danmaku[0]
    expect(first.type).toBe('chat')
    expect(first.content).toBe('重构后依然能解析')
    expect(first.user.nickname).toBe('小明')
    expect(first.platform).toBe('bilibili')
    expect(first.source).toBe('ws')
  })

  it('source 参数生效（DOM 兜底链路）', () => {
    const body = Buffer.from(JSON.stringify({ cmd: 'INTERACT_WORD', data: { uname: '观众' } }))
    const result = bilibiliAdapter.parseFrame(buildPacket(OP.MESSAGE, 0, body), '1', 'dom')
    expect(result.danmaku[0].source).toBe('dom')
    expect(result.danmaku[0].type).toBe('enter')
  })

  it('非 MESSAGE 帧（心跳）不产出弹幕', () => {
    const result = bilibiliAdapter.parseFrame(buildPacket(OP.HEARTBEAT, 0, Buffer.alloc(0)), '1', 'ws')
    expect(result.danmaku).toEqual([])
  })

  it('WS 端点判定与 DOM 兜底脚本仍在', () => {
    expect(bilibiliAdapter.isDanmakuWs('wss://broadcastlv.chat.bilibili.com/sub')).toBe(true)
    expect(bilibiliAdapter.isDanmakuWs('wss://webcast.douyin.com/webcast/im/push/')).toBe(false)
    expect(bilibiliAdapter.domFallbackScript()).toBeTruthy()
  })
})

describe('douyin adapter', () => {
  it('URL / WS 判定 / 发送脚本形态正确', () => {
    expect(douyinAdapter.roomUrl('123456')).toBe('https://live.douyin.com/123456')
    expect(douyinAdapter.isDanmakuWs('wss://webcast5-ws-web-lq.douyin.com/webcast/im/push/v2/')).toBe(
      true
    )
    expect(douyinAdapter.isDanmakuWs('wss://broadcastlv.chat.bilibili.com/sub')).toBe(false)
    expect(douyinAdapter.domFallbackScript()).toBeNull()
    expect(douyinAdapter.sendScript('你好')).toContain('"你好"')
  })

  it('非抖音帧不产出弹幕且不抛异常', () => {
    const result = douyinAdapter.parseFrame(Buffer.from([1, 2, 3, 4, 5]), '1', 'ws')
    expect(result.danmaku).toEqual([])
  })
})
