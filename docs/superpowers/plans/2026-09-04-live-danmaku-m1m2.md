# 直播弹幕助手 M1+M2 实施计划（骨架 + UI + B站弹幕捕获）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 Electron+Vue3 应用骨架与卡通磨砂 UI，并实现 B 站直播间弹幕的 WS Hook 捕获（含 DOM 兜底），弹幕流实时上屏。

**Architecture:** 隐藏 WebContentsView 加载直播间页面；主世界注入 WS Hook 脚本 → `window.postMessage` → preload 转发 IPC → 主进程解包解析为统一 `DanmakuMessage` → 事件总线推送渲染进程。8 秒未捕获 WS 连接则 reload 重试，仍失败降级 DOM MutationObserver 兜底。

**Tech Stack:** electron-vite 3、Electron 37、Vue 3.5、Pinia 3、TypeScript 5、vitest 3、Node zlib(brotli)。

**规格文档:** `docs/superpowers/specs/2026-09-03-直播弹幕助手-design.md`（本计划实现其 M1+M2；M3~M5 见 Plan 2）

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts`, `src/main/index.ts`(占位最小可启动), `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.ts`, `src/renderer/src/App.vue`, `.npmrc`

- [ ] **Step 1: 写入 `package.json`**

```json
{
  "name": "live-danmaku-assistant",
  "version": "0.1.0",
  "description": "直播弹幕助手：多平台弹幕捕获与AI回复",
  "main": "./out/main/index.js",
  "private": true,
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && vue-tsc --noEmit -p tsconfig.web.json"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.1",
    "electron": "^37.2.0",
    "electron-vite": "^3.1.0",
    "typescript": "^5.8.3",
    "vitest": "^3.1.4",
    "vue-tsc": "^2.2.10"
  },
  "dependencies": {
    "pinia": "^3.0.3",
    "vue": "^3.5.17",
    "zod": "^3.25.67"
  }
}
```

- [ ] **Step 2: 写入 `electron.vite.config.ts`**

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          webview: resolve(__dirname, 'src/preload/webview.ts')
        }
      }
    }
  },
  renderer: { plugins: [vue()] }
})
```

- [ ] **Step 3: 写入三个 tsconfig**

`tsconfig.json`:
```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

`tsconfig.node.json`（主进程/preload/测试）:
```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/main/**/*", "src/shared/**/*", "src/preload/**/*", "tests/**/*", "electron.vite.config.ts"]
}
```

`tsconfig.web.json`（渲染进程）:
```json
{
  "compilerOptions": {
    "composite": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/renderer/src/**/*", "src/renderer/src/**/*.vue", "src/shared/**/*"]
}
```

- [ ] **Step 4: 写入 `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' }
})
```

- [ ] **Step 5: 写入 `.npmrc`（Electron 二进制国内镜像，加速安装）**

```
electron_mirror=https://npmmirror.com/mirrors/electron/
```

- [ ] **Step 6: 写入最小占位源文件（Task 2/3 会替换）**

`src/main/index.ts`:
```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1080, minHeight: 640,
    show: false, autoHideMenuBar: true, backgroundColor: '#f3f0ff',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  win.on('ready-to-show', () => win.show())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

`src/preload/index.ts`:
```ts
import { contextBridge } from 'electron'
contextBridge.exposeInMainWorld('lda', { version: '0.1.0' })
```

`src/preload/webview.ts`（Task 8 补全，先占位）:
```ts
export {}
```

`src/renderer/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>直播弹幕助手</title></head>
  <body><div id="app"></div><script type="module" src="/src/main.ts"></script></body>
</html>
```

`src/renderer/src/main.ts`:
```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/theme.css'
createApp(App).use(createPinia()).mount('#app')
```

`src/renderer/src/App.vue`:
```vue
<template><div class="app-shell">直播弹幕助手</div></template>
```

- [ ] **Step 7: 安装依赖并验证启动**

```bash
npm install
npm run dev
```
Expected: Electron 窗口弹出，显示「直播弹幕助手」。Ctrl+C 退出。

- [ ] **Step 8: Commit**

```bash
git add package.json electron.vite.config.ts tsconfig*.json vitest.config.ts .npmrc src/
git commit -m "feat(m1): electron-vite 项目脚手架与最小可启动窗口"
```

---

### Task 2: 共享类型与 IPC 常量

**Files:**
- Create: `src/shared/types.ts`

- [ ] **Step 1: 写入 `src/shared/types.ts`（与规格第 4 节一致）**

```ts
export type Platform = 'bilibili' | 'douyin' | 'kuaishou'
export type DanmakuType = 'chat' | 'enter' | 'gift' | 'like' | 'follow' | 'share'
export type CaptureSource = 'ws' | 'dom'
export type RoomStatus = 'idle' | 'loading' | 'connected' | 'fallback-dom' | 'error' | 'closed'

export interface DanmakuUser {
  uid: string
  nickname: string
  avatar?: string
  guardLevel?: number
}

export interface GiftInfo { name: string; count: number; price: number }

export interface DanmakuMessage {
  id: string
  platform: Platform
  roomId: string
  type: DanmakuType
  user: DanmakuUser
  content: string
  gift?: GiftInfo
  ts: number
  source: CaptureSource
}

export interface RoomStatEvent {
  platform: Platform
  roomId: string
  onlineCount?: number
  danmakuRate: number
  ts: number
}

export interface RoomInfo {
  roomId: string
  platform: Platform
  status: RoomStatus
  addedAt: number
}

export const IPC = {
  roomAdd: 'room:add',
  roomRemove: 'room:remove',
  roomList: 'room:list',
  roomStatusChanged: 'room:status-changed',
  danmaku: 'danmaku:message',
  roomStat: 'room:stat',
  wvFrame: 'wv:frame',
  wvWsMeta: 'wv:ws-meta',
  wvInjectReady: 'wv:inject-ready',
  wvSendText: 'wv:send-text'
} as const
```

- [ ] **Step 2: 验证 typecheck 通过**

Run: `npm run typecheck`
Expected: 无错误退出（exit 0）

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(m1): 统一弹幕/房间类型与 IPC 通道常量"
```

---

### Task 3: 卡通磨砂主题设计令牌

**Files:**
- Create: `src/renderer/src/styles/theme.css`
- Modify: `src/renderer/src/App.vue`

- [ ] **Step 1: 写入 `theme.css`（规格第 8 节 tokens）**

```css
:root {
  /* 卡通糖果渐变背景 */
  --bg-gradient: linear-gradient(135deg, #ffd6e8 0%, #e7d9ff 45%, #bfe3ff 100%);
  /* 磨砂玻璃 */
  --glass-bg: rgba(255, 255, 255, 0.55);
  --glass-blur: blur(24px) saturate(1.6);
  /* 漫画描边与硬阴影（小圆角直边） */
  --ink: #2b2b3a;
  --border-bold: 2px solid var(--ink);
  --radius-sm: 6px;
  --radius-md: 10px;
  --shadow-hard: 4px 4px 0 rgba(43, 43, 58, 0.9);
  /* 类型着色 */
  --c-chat: rgba(255, 255, 255, 0.72);
  --c-ask: #d8f7e8;
  --c-gift: #ffe9a8;
  --c-enter: #ece2ff;
  --accent: #ff7eb3;
  --accent-2: #7ec8ff;
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Nunito', 'Segoe UI', sans-serif;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #app { height: 100%; }

body {
  background: var(--bg-gradient) fixed;
  color: var(--ink);
  overflow: hidden;
}

/* 磨砂玻璃卡片：粗描边 + 硬阴影 */
.glass-card {
  background: var(--glass-bg);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border: var(--border-bold);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-hard);
}

.btn-cartoon {
  font: inherit;
  padding: 6px 14px;
  background: var(--accent);
  color: #fff;
  border: var(--border-bold);
  border-radius: var(--radius-sm);
  box-shadow: 3px 3px 0 rgba(43, 43, 58, 0.9);
  cursor: pointer;
  transition: transform 0.08s ease;
}
.btn-cartoon:hover { transform: translate(-1px, -1px); }
.btn-cartoon:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 rgba(43, 43, 58, 0.9); }
.btn-cartoon:disabled { opacity: 0.5; cursor: not-allowed; }

.input-cartoon {
  font: inherit;
  padding: 6px 10px;
  border: var(--border-bold);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.75);
  outline: none;
}
.input-cartoon:focus { border-color: var(--accent); }
```

- [ ] **Step 2: 替换 `App.vue` 为布局骨架（引用 glass-card 验证样式生效）**

```vue
<template>
  <div class="app-shell">
    <header class="glass-card topbar">直播弹幕助手</header>
    <aside class="glass-card sidebar">房间管理</aside>
    <main class="glass-card feed">弹幕流</main>
    <section class="glass-card reply">AI 回复面板</section>
    <footer class="glass-card statusbar">状态栏</footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: grid;
  height: 100%;
  gap: 10px;
  padding: 10px;
  grid-template-columns: 220px 1fr 300px;
  grid-template-rows: 52px 1fr 32px;
  grid-template-areas: 'top top top' 'side feed reply' 'status status status';
}
.topbar { grid-area: top; display: flex; align-items: center; padding: 0 16px; font-weight: 700; }
.sidebar { grid-area: side; }
.feed { grid-area: feed; }
.reply { grid-area: reply; }
.statusbar { grid-area: status; display: flex; align-items: center; padding: 0 12px; font-size: 12px; }
</style>
```

- [ ] **Step 3: 手动验证**

Run: `npm run dev`
Expected: 五个磨砂玻璃卡片布局，糖果渐变背景、粗描边、硬阴影、6px 小圆角。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/
git commit -m "feat(m1): 卡通磨砂主题tokens与三栏布局骨架"
```

---

### Task 4: 主窗口 preload 桥与窗口端类型声明

**Files:**
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/env.d.ts`

- [ ] **Step 1: 替换 `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { DanmakuMessage, RoomInfo, RoomStatEvent } from '../shared/types'
import { IPC } from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  addRoom: (input: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.roomAdd, input),
  removeRoom: (roomId: string): Promise<void> => ipcRenderer.invoke(IPC.roomRemove, roomId),
  listRooms: (): Promise<RoomInfo[]> => ipcRenderer.invoke(IPC.roomList),
  onDanmaku: (cb: (m: DanmakuMessage) => void) => subscribe(IPC.danmaku, cb),
  onRoomStatus: (cb: (r: RoomInfo) => void) => subscribe(IPC.roomStatusChanged, cb),
  onRoomStat: (cb: (s: RoomStatEvent) => void) => subscribe(IPC.roomStat, cb)
}

contextBridge.exposeInMainWorld('lda', api)
export type LdaApi = typeof api
```

- [ ] **Step 2: 写入 `src/renderer/src/env.d.ts`**

```ts
import type { LdaApi } from '../../preload/index'

declare global {
  interface Window { lda: LdaApi }
}
export {}
```

注意：`tsconfig.web.json` 的 include 未含 preload，为让该 import 通过，在 `tsconfig.web.json` 的 `include` 数组追加 `"src/preload/index.ts"`。

- [ ] **Step 3: 验证 typecheck**

Run: `npm run typecheck`
Expected: exit 0（webview.ts 中 `export {}` 需要 tsconfig.node 包含它，已满足）

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/renderer/src/env.d.ts tsconfig.web.json
git commit -m "feat(m1): 渲染进程 preload 桥(lda API)与类型声明"
```

---

### Task 5: B站二进制协议解包器（TDD）

**Files:**
- Create: `src/main/adapters/bilibili/protocol.ts`
- Test: `tests/bilibili-protocol.test.ts`

背景：弹幕 WS 帧头 16 字节：`[0..3]` 包长(BE)、`[4..5]` 头长(BE,=16)、`[6..7]` 协议版本、`[8..11]` 操作码、`[12..15]` 序列。protover 3 = brotli 压缩，解压后为若干子帧；protover 0 = 裸 JSON。页面自己完成认证，我们只旁听 op=5 消息帧。

- [ ] **Step 1: 写失败测试 `tests/bilibili-protocol.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { brotliCompressSync } from 'zlib'
import { OP, buildPacket, splitPackets, decodeBody } from '../src/main/adapters/bilibili/protocol'

describe('bilibili protocol', () => {
  it('splitPackets 解析单帧头字段', () => {
    const frame = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"x"}'))
    const packets = splitPackets(frame)
    expect(packets).toHaveLength(1)
    expect(packets[0].op).toBe(OP.MESSAGE)
    expect(packets[0].protover).toBe(0)
    expect(packets[0].body.toString()).toBe('{"cmd":"x"}')
  })

  it('splitPackets 解析串联多帧', () => {
    const a = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"a"}'))
    const b = buildPacket(OP.HEARTBEAT_REPLY, 1, Buffer.from([0, 0, 0, 100]))
    const packets = splitPackets(Buffer.concat([a, b]))
    expect(packets).toHaveLength(2)
    expect(packets[1].op).toBe(OP.HEARTBEAT_REPLY)
    expect(packets[1].body.readUInt32BE(0)).toBe(100)
  })

  it('decodeBody 解压 protover=3 brotli 并拆出子帧 body', () => {
    const inner1 = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"DANMU_MSG"}'))
    const inner2 = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"INTERACT_WORD"}'))
    const outer = buildPacket(OP.MESSAGE, 3, brotliCompressSync(Buffer.concat([inner1, inner2])))
    const bodies = decodeBody(splitPackets(outer)[0])
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[0].toString()).cmd).toBe('DANMU_MSG')
  })

  it('decodeBody protover=0 原样返回', () => {
    const frame = buildPacket(OP.MESSAGE, 0, Buffer.from('[1,2]'))
    expect(decodeBody(splitPackets(frame)[0])).toHaveLength(1)
  })

  it('截断的帧尾被安全忽略', () => {
    const frame = buildPacket(OP.MESSAGE, 0, Buffer.from('{"cmd":"a"}'))
    const truncated = Buffer.concat([frame, Buffer.from([0, 0])])
    expect(splitPackets(truncated)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（protocol.ts 不存在）

- [ ] **Step 3: 实现 `src/main/adapters/bilibili/protocol.ts`**

```ts
import { brotliDecompressSync } from 'zlib'

export const OP = {
  HEARTBEAT: 2,
  HEARTBEAT_REPLY: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_REPLY: 8
} as const

const HEADER_LEN = 16

export interface RawPacket {
  op: number
  protover: number
  body: Buffer
}

/** 将一帧（或多个串联帧）的缓冲拆为 RawPacket 列表，截断尾包安全忽略 */
export function splitPackets(buf: Buffer): RawPacket[] {
  const packets: RawPacket[] = []
  let offset = 0
  while (offset + HEADER_LEN <= buf.length) {
    const packetLen = buf.readUInt32BE(offset)
    if (packetLen < HEADER_LEN || offset + packetLen > buf.length) break
    const headerLen = buf.readUInt16BE(offset + 4)
    packets.push({
      protover: buf.readUInt16BE(offset + 6),
      op: buf.readUInt32BE(offset + 8),
      body: buf.subarray(offset + headerLen, offset + packetLen)
    })
    offset += packetLen
  }
  return packets
}

/** 解出可读 body：protover 3 先 brotli 解压再拆子帧，返回子帧 body 列表 */
export function decodeBody(packet: RawPacket): Buffer[] {
  if (packet.protover === 3) {
    const raw = brotliDecompressSync(packet.body)
    return splitPackets(raw).map((p) => p.body)
  }
  if (packet.protover === 0) return [packet.body]
  return [] // protover 1(人气) 等由调用方另行处理
}

/** 仅测试用：按协议构造一帧 */
export function buildPacket(op: number, protover: number, body: Buffer): Buffer {
  const head = Buffer.alloc(HEADER_LEN)
  head.writeUInt32BE(HEADER_LEN + body.length, 0)
  head.writeUInt16BE(HEADER_LEN, 4)
  head.writeUInt16BE(protover, 6)
  head.writeUInt32BE(op, 8)
  head.writeUInt32BE(1, 12)
  return Buffer.concat([head, body])
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 5 个测试全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/bilibili/protocol.ts tests/bilibili-protocol.test.ts
git commit -m "feat(m2): B站弹幕二进制协议解包器(TDD)"
```

---

### Task 6: B站消息映射器（TDD）

**Files:**
- Create: `src/main/adapters/bilibili/mapper.ts`
- Test: `tests/bilibili-mapper.test.ts`

- [ ] **Step 1: 写失败测试 `tests/bilibili-mapper.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
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
    )
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
    )
    expect(msg!.type).toBe('enter')
    expect(msg!.user.nickname).toBe('路过的小王')
  })

  it('SEND_GIFT 映射为 gift 且含礼物信息', () => {
    const msg = mapBilibiliEvent(
      'SEND_GIFT',
      { data: { uid: 8, uname: '土豪哥', giftName: '小花花', num: 10, price: 100, face: '' } },
      '10086',
      'ws'
    )
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL（mapper.ts 不存在）

- [ ] **Step 3: 实现 `src/main/adapters/bilibili/mapper.ts`**

```ts
import type { CaptureSource, DanmakuMessage, RoomStatEvent } from '../../../shared/types'

export type MappedEvent = DanmakuMessage | RoomStatEvent | null

let seq = 0

function makeId(roomId: string, uid: string, kind: string): string {
  seq = (seq + 1) % 1_000_000
  return `bili:${roomId}:${uid}:${kind}:${Date.now()}:${seq}`
}

/**
 * 将一条 B 站弹幕 WS 的 JSON 事件映射为统一结构。
 * DANMU_MSG 的 payload 是 info 数组，其余 cmd 的 payload 是 { cmd, data } 中的 data 对象。
 */
export function mapBilibiliEvent(
  cmd: string,
  payload: unknown,
  roomId: string,
  source: CaptureSource
): MappedEvent {
  const ts = Date.now()
  const base = { platform: 'bilibili' as const, roomId, ts, source }

  if (cmd.startsWith('DANMU_MSG')) {
    const info = payload as unknown[]
    const content = String(info?.[1] ?? '')
    const u = (info?.[2] ?? []) as unknown[]
    const medal = (info?.[3] ?? []) as unknown[]
    return {
      ...base,
      id: makeId(roomId, String(u?.[0] ?? ''), 'chat'),
      type: 'chat',
      user: {
        uid: String(u?.[0] ?? ''),
        nickname: String(u?.[1] ?? '未知用户'),
        avatar: u?.[2] ? String(u[2]) : undefined,
        guardLevel: Number(medal?.[1] ?? 0) || undefined
      },
      content
    }
  }

  const data = (payload as { data?: Record<string, unknown> })?.data ?? {}

  switch (cmd) {
    case 'INTERACT_WORD':
      return {
        ...base,
        id: makeId(roomId, String(data['uid'] ?? ''), 'enter'),
        type: 'enter',
        user: { uid: String(data['uid'] ?? ''), nickname: String(data['uname'] ?? '') },
        content: ''
      }
    case 'SEND_GIFT': {
      const price = Number(data['price'] ?? 0) // 单位：0.1 元
      return {
        ...base,
        id: makeId(roomId, String(data['uid'] ?? ''), 'gift'),
        type: 'gift',
        user: {
          uid: String(data['uid'] ?? ''),
          nickname: String(data['uname'] ?? ''),
          avatar: data['face'] ? String(data['face']) : undefined
        },
        content: '',
        gift: {
          name: String(data['giftName'] ?? ''),
          count: Number(data['num'] ?? 1),
          price: price / 10
        }
      }
    }
    case 'GUARD_BUY':
      return {
        ...base,
        id: makeId(roomId, String(data['uid'] ?? ''), 'gift'),
        type: 'gift',
        user: { uid: String(data['uid'] ?? ''), nickname: String(data['username'] ?? '') },
        content: '',
        gift: { name: String(data['gift_name'] ?? '舰长'), count: Number(data['num'] ?? 1), price: 0 }
      }
    case 'WATCHED_CHANGE':
      return {
        platform: 'bilibili',
        roomId,
        onlineCount: Number(data['num'] ?? 0),
        danmakuRate: -1, // 由总线填充本地统计
        ts
      }
    default:
      return null
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/adapters/bilibili/mapper.ts tests/bilibili-mapper.test.ts
git commit -m "feat(m2): B站事件到统一弹幕结构的映射器(TDD)"
```

---

### Task 7: WS Hook 注入脚本 + WebView preload 桥

**Files:**
- Create: `src/main/webview/inject/wsHook.ts`
- Modify: `src/preload/webview.ts`

架构要点：主进程用 `webContents.executeJavaScript` 在**主世界**注入（与页面脚本同一 `window.WebSocket`）；主世界无 Node 能力，数据经 `window.postMessage` 发给 **isolated world** 的 preload（`src/preload/webview.ts`），preload 再经 IPC 转发主进程（WS 帧与 DOM 兜底消息均走此通道）。反向（发送指令）同理倒序。

- [ ] **Step 1: 写入 `src/main/webview/inject/wsHook.ts`（导出注入字符串）**

```ts
/**
 * 主世界 WS Hook：包装 window.WebSocket，识别弹幕服务器连接，
 * 把二进制帧转发到 isolated world（preload）→ 主进程。
 */
export const WS_HOOK_SCRIPT = String.raw`
(function () {
  if (window.__LDA_HOOKED__) return 'already'
  window.__LDA_HOOKED__ = true
  var NativeWS = window.WebSocket
  var DANMAKU_RE = /broadcastlv/i
  function send(buf) {
    try { window.postMessage({ __LDA__: 'ws-frame', buf: buf }, '*', [buf]) } catch (e) {}
  }
  window.postMessage({ __LDA__: 'ws-hook-installed' }, '*')
  function HookedWebSocket(url, protocols) {
    var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols)
    if (DANMAKU_RE.test(String(url))) {
      window.postMessage({ __LDA__: 'ws-meta', url: String(url) }, '*')
      ws.binaryType = 'arraybuffer'
      ws.addEventListener('message', function (ev) {
        if (ev.data instanceof ArrayBuffer) send(ev.data.slice(0))
        else if (ev.data instanceof Blob) ev.data.arrayBuffer().then(send)
      })
    }
    return ws
  }
  HookedWebSocket.prototype = NativeWS.prototype
  HookedWebSocket.CONNECTING = NativeWS.CONNECTING
  HookedWebSocket.OPEN = NativeWS.OPEN
  HookedWebSocket.CLOSING = NativeWS.CLOSING
  HookedWebSocket.CLOSED = NativeWS.CLOSED
  window.WebSocket = HookedWebSocket
  return 'installed'
})()
`
```

- [ ] **Step 2: 替换 `src/preload/webview.ts`（桥接双向）**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'

// 主世界 → preload → 主进程（弹幕帧 / WS 元信息 / 注入就绪 / DOM 兜底消息）
window.addEventListener('message', (ev) => {
  const d = ev.data as { __LDA__?: string; buf?: ArrayBuffer; url?: string; messages?: Array<{ nickname: string; content: string }> } | null
  if (!d || typeof d !== 'object' || !d.__LDA__) return
  if (d.__LDA__ === 'ws-frame' && d.buf instanceof ArrayBuffer) {
    ipcRenderer.send(IPC.wvFrame, new Uint8Array(d.buf))
  } else if (d.__LDA__ === 'ws-meta') {
    ipcRenderer.send(IPC.wvWsMeta, d.url ?? '')
  } else if (d.__LDA__ === 'ws-hook-installed') {
    ipcRenderer.send(IPC.wvInjectReady)
  } else if (d.__LDA__ === 'dom-messages' && Array.isArray(d.messages)) {
    ipcRenderer.send('wv:dom-messages', d.messages)
  }
})

// 主进程 → preload → 主世界（发送文本指令，M3 使用）
contextBridge.exposeInMainWorld('__ldaWv', {
  onSendText: (cb: (text: string) => void): void => {
    ipcRenderer.on(IPC.wvSendText, (_e, text: string) => {
      window.postMessage({ __LDA__: 'do-send', text }, '*')
    })
  }
})
```

- [ ] **Step 3: typecheck + Commit**

Run: `npm run typecheck` → exit 0

```bash
git add src/main/webview/inject/wsHook.ts src/preload/webview.ts
git commit -m "feat(m2): WS Hook 注入脚本与 WebView preload 双向桥"
```

---

### Task 8: DOM 兜底注入脚本

**Files:**
- Create: `src/main/webview/inject/domObserver.ts`

- [ ] **Step 1: 写入 `src/main/webview/inject/domObserver.ts`**

```ts
/**
 * DOM 兜底：MutationObserver 监听 B 站网页端弹幕列表，提取 用户名+内容。
 * 仅 chat 类型；id 由 roomId+ts+内容哈希合成（规格第 4 节兜底规则）。
 */
export const DOM_OBSERVER_SCRIPT = String.raw`
(function () {
  if (window.__LDA_DOM__) return 'already'
  window.__LDA_DOM__ = true
  var CONTAINER_SELS = ['.danmaku-item-container', '.chat-history-list', '[class*=danmaku-item-container]']
  var ITEM_SELS = ['.danmaku-item', '[class*=danmaku-item]']
  var NAME_SELS = ['.danmaku-item-user-name', '[class*=user-name]']
  var TEXT_SELS = ['.danmaku-item-text', '[class*=danmaku-item-text]']

  function findContainer() {
    for (var i = 0; i < CONTAINER_SELS.length; i++) {
      var el = document.querySelector(CONTAINER_SELS[i])
      if (el) return el
    }
    return null
  }

  function parseItem(item, out) {
    var nameEl = item.querySelector(NAME_SELS.join(','))
    var textEl = item.querySelector(TEXT_SELS.join(','))
    if (!textEl) return
    var name = nameEl ? nameEl.textContent.trim() : '未知用户'
    var content = textEl.textContent.trim()
    if (!content) return
    var key = name + '|' + content
    if (out._seen && out._seen[key]) return
    out.push({ nickname: name, content: content })
    out._seen = out._seen || {}
    out._seen[key] = true
  }

  function start() {
    var container = findContainer()
    if (!container) { setTimeout(start, 1000); return }
    window.postMessage({ __LDA__: 'dom-ready' }, '*')
    var batch = []
    var flush = setInterval(function () {
      if (!batch.length) return
      var payload = batch.splice(0, batch.length)
      window.postMessage({ __LDA__: 'dom-messages', messages: payload }, '*')
    }, 500)
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        Array.prototype.forEach.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1) return
          if (n.matches(ITEM_SELS.join(','))) parseItem(n, batch)
          else if (n.querySelectorAll) {
            n.querySelectorAll(ITEM_SELS.join(',')).forEach(function (it) { parseItem(it, batch) })
          }
        })
      })
    }).observe(container, { childList: true, subtree: true })
  }
  start()
  return 'dom-observer-started'
})()
`
```

- [ ] **Step 2: Commit**

```bash
git add src/main/webview/inject/domObserver.ts
git commit -m "feat(m2): DOM 兜底弹幕监听注入脚本"
```

---

### Task 9: webviewManager（WebView 生命周期 + 注入编排 + 解析管线）

**Files:**
- Create: `src/main/webview/webviewManager.ts`, `src/main/webview/bus.ts`

- [ ] **Step 1: 写入 `src/main/webview/bus.ts`（事件总线 + 60s 速率统计）**

```ts
import { EventEmitter } from 'events'
import type { DanmakuMessage, RoomStatEvent } from '../shared/types'

class DanmakuBus extends EventEmitter {
  private timestamps: number[] = []

  publish(msg: DanmakuMessage): void {
    this.timestamps.push(msg.ts)
    this.emit('danmaku', msg)
  }

  /** 近 60 秒弹幕条数（供 RoomStatEvent.danmakuRate） */
  rate60s(now = Date.now()): number {
    this.timestamps = this.timestamps.filter((t) => now - t <= 60_000)
    return this.timestamps.length
  }

  buildStat(platform: RoomStatEvent['platform'], roomId: string, onlineCount?: number): RoomStatEvent {
    return { platform, roomId, onlineCount, danmakuRate: this.rate60s(), ts: Date.now() }
  }
}

export const bus = new DanmakuBus()
```

- [ ] **Step 2: 写入 `src/main/webview/webviewManager.ts`**

```ts
import { WebContentsView, ipcMain, BrowserWindow } from 'electron'
import { join } from 'path'
import { brotliDecompressSync } from 'zlib'
import type { DanmakuMessage, Platform, RoomInfo, RoomStatus } from '../shared/types'
import { IPC } from '../shared/types'
import { OP, splitPackets } from '../adapters/bilibili/protocol'
import { mapBilibiliEvent } from '../adapters/bilibili/mapper'
import { WS_HOOK_SCRIPT } from './inject/wsHook'
import { DOM_OBSERVER_SCRIPT } from './inject/domObserver'
import { bus } from './bus'

interface RoomSession {
  info: RoomInfo
  view: WebContentsView
  gotWsMeta: boolean
  domMode: boolean
  retryCount: number
  watchdog: NodeJS.Timeout
}

const PLATFORM_URL: Record<Platform, (id: string) => string> = {
  bilibili: (id) => `https://live.bilibili.com/${id}`,
  douyin: (id) => `https://live.douyin.com/${id}`,
  kuaishou: (id) => `https://live.kuaishou.com/u/${id}`
}

const rooms = new Map<string, RoomSession>()
let mainWindow: BrowserWindow | null = null

export function bindMainWindow(win: BrowserWindow): void {
  mainWindow = win
}

function setStatus(room: RoomSession, status: RoomStatus): void {
  room.info.status = status
  mainWindow?.webContents.send(IPC.roomStatusChanged, room.info)
}

function handleFrame(room: RoomSession, data: Uint8Array): void {
  const buf = Buffer.from(data)
  try {
    for (const packet of splitPackets(buf)) {
      if (packet.op !== OP.MESSAGE) continue // 认证/心跳由页面自身处理
      let bodies: Buffer[]
      if (packet.protover === 3) {
        bodies = splitPackets(brotliDecompressSync(packet.body)).map((p) => p.body)
      } else if (packet.protover === 0) {
        bodies = [packet.body]
      } else continue
      for (const body of bodies) {
        let event: Record<string, unknown>
        try { event = JSON.parse(body.toString('utf8')) } catch { continue }
        const cmd = String(event['cmd'] ?? '')
        const mapped = mapBilibiliEvent(cmd, event, room.info.roomId, room.domMode ? 'dom' : 'ws')
        if (mapped && 'type' in mapped) bus.publish(mapped as DanmakuMessage)
        else if (mapped) {
          mainWindow?.webContents.send(IPC.roomStat, mapped)
        }
      }
    }
  } catch (err) {
    console.error('[wv] frame parse error', err)
  }
}

function startDomFallback(room: RoomSession): void {
  if (room.domMode) return
  room.domMode = true
  void room.view.webContents.executeJavaScript(DOM_OBSERVER_SCRIPT).then(() => {
    setStatus(room, 'fallback-dom')
  })
}

export async function openRoom(platform: Platform, roomId: string): Promise<void> {
  if (rooms.has(roomId)) return
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/webview.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  const session: RoomSession = {
    info: { roomId, platform, status: 'loading', addedAt: Date.now() },
    view,
    gotWsMeta: false,
    domMode: false,
    retryCount: 0,
    watchdog: null as unknown as NodeJS.Timeout
  }
  rooms.set(roomId, session)

  // 放到屏幕外隐藏，仍保持网络与 JS 活动
  const host = mainWindow
  if (host) host.contentView.addChildView(view)
  view.setBounds({ x: -20000, y: 0, width: 1280, height: 800 })

  const armWatchdog = (): void => {
    clearTimeout(session.watchdog)
    session.watchdog = setTimeout(() => {
      if (session.gotWsMeta || session.domMode) return
      if (session.retryCount < 1) {
        session.retryCount += 1
        view.webContents.reload()
        armWatchdog()
      } else {
        startDomFallback(session)
      }
    }, 8000)
  }

  view.webContents.on('dom-ready', async () => {
    await view.webContents.executeJavaScript(WS_HOOK_SCRIPT).catch(() => 'inject-failed')
  })

  view.webContents.on('render-process-gone', (_e, details) => {
    console.error('[wv] renderer gone', details.reason)
    setStatus(session, 'error')
  })

  ensureIpcRoutes()

  armWatchdog()
  await view.webContents.loadURL(PLATFORM_URL[platform](roomId))
}

/** IPC 路由模块级幂等注册一次，按 sender 路由到对应房间（避免每房间重复注册导致泄漏） */
let routesRegistered = false
function ensureIpcRoutes(): void {
  if (routesRegistered) return
  routesRegistered = true
  const roomBySender = (sender: Electron.WebContents): RoomSession | undefined =>
    Array.from(rooms.values()).find((r) => r.view.webContents === sender)

  ipcMain.on(IPC.wvInjectReady, () => { /* hook 安装确认，无需处理 */ })
  ipcMain.on(IPC.wvWsMeta, (e, url: string) => {
    const room = roomBySender(e.sender)
    if (!room) return
    room.gotWsMeta = true
    clearTimeout(room.watchdog)
    setStatus(room, 'connected')
    console.log('[wv] danmaku ws:', url)
  })
  ipcMain.on(IPC.wvFrame, (e, data: Uint8Array) => {
    const room = roomBySender(e.sender)
    if (room) handleFrame(room, data)
  })
  ipcMain.on('wv:dom-messages', (e, messages: Array<{ nickname: string; content: string }>) => {
    const room = roomBySender(e.sender)
    if (!room) return
    for (const m of messages) {
      bus.publish({
        id: `bili:${room.info.roomId}:${Date.now()}:${Math.abs(hash(m.content))}`,
        platform: 'bilibili',
        roomId: room.info.roomId,
        type: 'chat',
        user: { uid: '', nickname: m.nickname },
        content: m.content,
        ts: Date.now(),
        source: 'dom'
      })
    }
  })
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

export function closeRoom(roomId: string): void {
  const room = rooms.get(roomId)
  if (!room) return
  clearTimeout(room.watchdog)
  if (mainWindow) mainWindow.contentView.removeChildView(room.view)
  void room.view.webContents.close()
  rooms.delete(roomId)
  setStatus(room, 'closed')
}

export function listRooms(): RoomInfo[] {
  return Array.from(rooms.values()).map((r) => ({ ...r.info }))
}
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add src/main/webview/
git commit -m "feat(m2): webviewManager 多房间 WebView 生命周期与 WS/DOM 双模式解析管线"
```

---

### Task 10: 房间 IPC 与总线→渲染进程转发

**Files:**
- Create: `src/main/rooms/ipc.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: 写入 `src/main/rooms/ipc.ts`**

```ts
import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/types'
import type { DanmakuMessage } from '../../shared/types'
import { openRoom, closeRoom, listRooms, bindMainWindow } from '../webview/webviewManager'
import { bus } from '../webview/bus'

const ROOM_ID_RE = /(\d{4,})/

export function registerRoomIpc(win: BrowserWindow): void {
  bindMainWindow(win)

  bus.on('danmaku', (msg: DanmakuMessage) => {
    win.webContents.send(IPC.danmaku, msg)
  })
  // 每 10 秒推送一次各房间统计
  setInterval(() => {
    for (const room of listRooms()) {
      if (room.status === 'closed') continue
      win.webContents.send(IPC.roomStat, {
        platform: room.platform,
        roomId: room.roomId,
        danmakuRate: bus.rate60s(),
        ts: Date.now()
      })
    }
  }, 10_000).unref()

  ipcMain.handle(IPC.roomAdd, (_e, input: string) => {
    const text = String(input ?? '').trim()
    if (!text) return { ok: false, error: '请输入直播间地址或房间号' }
    const m = text.match(ROOM_ID_RE)
    if (!m) return { ok: false, error: '无法从输入中解析房间号' }
    void openRoom('bilibili', m[1])
    return { ok: true }
  })

  ipcMain.handle(IPC.roomRemove, (_e, roomId: string) => {
    closeRoom(String(roomId))
  })

  ipcMain.handle(IPC.roomList, () => listRooms())
}
```

- [ ] **Step 2: 修改 `src/main/index.ts`，创建窗口后注册 IPC**

将 `app.whenReady().then(() => { createWindow() ... })` 中的 `createWindow()` 调用改为：

```ts
app.whenReady().then(() => {
  const win = createWindow()
  registerRoomIpc(win)
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
```

并在文件顶部加入：

```ts
import { registerRoomIpc } from './rooms/ipc'
```

- [ ] **Step 3: typecheck + Commit**

Run: `npm run typecheck` → exit 0

```bash
git add src/main/
git commit -m "feat(m2): 房间管理 IPC 与弹幕总线转发渲染进程"
```

---

### Task 11: 渲染进程 Store 与弹幕流 UI

**Files:**
- Create: `src/renderer/src/stores/rooms.ts`, `src/renderer/src/stores/danmaku.ts`, `src/renderer/src/components/RoomPanel.vue`, `src/renderer/src/components/DanmakuList.vue`, `src/renderer/src/components/DanmakuItem.vue`
- Modify: `src/renderer/src/App.vue`

- [ ] **Step 1: 写入 `src/renderer/src/stores/rooms.ts`**

```ts
import { defineStore } from 'pinia'
import type { RoomInfo, RoomStatEvent } from '../../../shared/types'

export const useRoomStore = defineStore('rooms', {
  state: () => ({
    rooms: [] as RoomInfo[],
    rates: {} as Record<string, number>,
    online: {} as Record<string, number | undefined>
  }),
  actions: {
    async refresh() { this.rooms = await window.lda.listRooms() },
    async add(input: string) {
      const res = await window.lda.addRoom(input)
      await this.refresh()
      return res
    },
    async remove(roomId: string) {
      await window.lda.removeRoom(roomId)
      await this.refresh()
    },
    applyStatus(r: RoomInfo) {
      const i = this.rooms.findIndex((x) => x.roomId === r.roomId)
      if (i >= 0) this.rooms[i] = r
      else this.rooms.push(r)
    },
    applyStat(s: RoomStatEvent) {
      this.rates[s.roomId] = s.danmakuRate
      this.online[s.roomId] = s.onlineCount
    }
  }
})
```

- [ ] **Step 2: 写入 `src/renderer/src/stores/danmaku.ts`**

```ts
import { defineStore } from 'pinia'
import type { DanmakuMessage } from '../../../shared/types'

const MAX_ITEMS = 200

export const useDanmakuStore = defineStore('danmaku', {
  state: () => ({ items: [] as DanmakuMessage[] }),
  actions: {
    push(m: DanmakuMessage) {
      this.items.push(m)
      if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS)
    },
    clear() { this.items = [] }
  }
})
```

- [ ] **Step 3: 写入 `src/renderer/src/components/DanmakuItem.vue`**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import type { DanmakuMessage } from '../../../shared/types'
const props = defineProps<{ msg: DanmakuMessage }>()

const cls = computed(() => ({
  chat: 'row--chat',
  enter: 'row--enter',
  gift: 'row--gift',
  like: 'row--chat',
  follow: 'row--chat',
  share: 'row--chat'
}[props.msg.type]))

const isQuestion = computed(() => /[？?]|吗|呢/.test(props.msg.content))
</script>

<template>
  <div class="dm-item glass-card" :class="[cls, { 'dm-item--ask': isQuestion && msg.type === 'chat' }]">
    <span class="dm-avatar">{{ msg.user.nickname.slice(0, 1) }}</span>
    <div class="dm-body">
      <div class="dm-head">
        <span class="dm-name">{{ msg.user.nickname }}</span>
        <span v-if="msg.user.guardLevel" class="dm-medal">Lv{{ msg.user.guardLevel }}</span>
        <span v-if="msg.source === 'dom'" class="dm-tag">兜底</span>
      </div>
      <div class="dm-content">{{ msg.content }}</div>
      <div v-if="msg.type === 'gift'" class="dm-gift">🎁 {{ msg.gift?.name }} ×{{ msg.gift?.count }}</div>
    </div>
  </div>
</template>

<style scoped>
.dm-item { display: flex; gap: 8px; padding: 8px 10px; margin-bottom: 8px; }
.dm-item--chat { background: var(--c-chat); }
.dm-item--ask { background: var(--c-ask); }
.dm-item--gift { background: var(--c-gift); }
.dm-item--enter { background: var(--c-enter); opacity: 0.85; }
.dm-avatar {
  flex: none; width: 30px; height: 30px; border-radius: 6px;
  border: 2px solid var(--ink); background: var(--accent-2);
  display: grid; place-items: center; font-weight: 700; color: #fff;
}
.dm-head { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.dm-name { font-weight: 700; }
.dm-medal { background: var(--accent); color: #fff; border: 1.5px solid var(--ink); border-radius: 4px; padding: 0 4px; font-size: 11px; }
.dm-tag { border: 1.5px solid var(--ink); border-radius: 4px; padding: 0 4px; font-size: 11px; background: #fff; }
.dm-content { margin-top: 2px; line-height: 1.4; word-break: break-all; }
.dm-gift { font-size: 12px; margin-top: 2px; }
</style>
```

- [ ] **Step 4: 写入 `src/renderer/src/components/DanmakuList.vue`**

```vue
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useDanmakuStore } from '../stores/danmaku'
import DanmakuItem from './DanmakuItem.vue'

const store = useDanmakuStore()
const scroller = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

watch(
  () => store.items.length,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
  }
)

function onScroll(): void {
  const el = scroller.value
  if (!el) return
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}
</script>

<template>
  <div ref="scroller" class="dm-list" @scroll="onScroll">
    <p v-if="store.items.length === 0" class="dm-empty">暂无弹幕，先在左侧添加一个直播间吧～</p>
    <DanmakuItem v-for="m in store.items" :key="m.id" :msg="m" />
  </div>
</template>

<style scoped>
.dm-list { height: 100%; overflow-y: auto; padding: 12px; }
.dm-empty { opacity: 0.6; text-align: center; margin-top: 40%; }
</style>
```

- [ ] **Step 5: 写入 `src/renderer/src/components/RoomPanel.vue`**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoomStore } from '../stores/rooms'

const store = useRoomStore()
const input = ref('')
const error = ref('')

const STATUS_LABEL: Record<string, string> = {
  idle: '待机', loading: '连接中…', connected: '在线',
  'fallback-dom': '兜底模式', error: '异常', closed: '已关闭'
}
const STATUS_DOT: Record<string, string> = {
  connected: '#4caf7d', loading: '#f0a742', 'fallback-dom': '#f0a742',
  error: '#e05656', idle: '#999', closed: '#999'
}

async function add(): Promise<void> {
  error.value = ''
  const res = await store.add(input.value)
  if (!res.ok) error.value = res.error ?? '添加失败'
  else input.value = ''
}

onMounted(() => {
  void store.refresh()
  window.lda.onRoomStatus((r) => store.applyStatus(r))
  window.lda.onRoomStat((s) => store.applyStat(s))
})
</script>

<template>
  <div class="room-panel">
    <div class="room-add">
      <input v-model="input" class="input-cartoon" placeholder="B站直播间地址/房间号" @keydown.enter="add" />
      <button class="btn-cartoon" @click="add">添加</button>
      <p v-if="error" class="room-error">{{ error }}</p>
    </div>
    <ul class="room-list">
      <li v-for="r in store.rooms" :key="r.roomId" class="room-row">
        <span class="room-dot" :style="{ background: STATUS_DOT[r.status] }" />
        <span class="room-id">B站 {{ r.roomId }}</span>
        <span class="room-status">{{ STATUS_LABEL[r.status] }}</span>
        <button class="room-remove" title="移除" @click="store.remove(r.roomId)">×</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.room-panel { display: flex; flex-direction: column; height: 100%; padding: 12px; gap: 12px; }
.room-add { display: flex; gap: 6px; flex-wrap: wrap; }
.room-add input { flex: 1 1 100%; }
.room-error { color: #e05656; font-size: 12px; width: 100%; }
.room-list { list-style: none; overflow-y: auto; }
.room-row { display: flex; align-items: center; gap: 6px; padding: 8px; border: 2px solid var(--ink); border-radius: 6px; background: rgba(255,255,255,.6); margin-bottom: 8px; }
.room-dot { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--ink); flex: none; }
.room-id { font-weight: 700; font-size: 13px; }
.room-status { font-size: 11px; opacity: 0.7; margin-left: auto; }
.room-remove { border: none; background: none; font-size: 16px; cursor: pointer; color: #e05656; }
</style>
```

- [ ] **Step 6: 更新 `App.vue`（组装组件 + 订阅弹幕 + 顶栏速率）**

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import RoomPanel from './components/RoomPanel.vue'
import DanmakuList from './components/DanmakuList.vue'
import { useDanmakuStore } from './stores/danmaku'
import { useRoomStore } from './stores/rooms'

const danmaku = useDanmakuStore()
const rooms = useRoomStore()
const rate = ref(0)
const online = ref<number | undefined>(undefined)

onMounted(() => {
  window.lda.onDanmaku((m) => danmaku.push(m))
  window.lda.onRoomStat((s) => {
    rooms.applyStat(s)
    rate.value = s.danmakuRate
    if (s.onlineCount) online.value = s.onlineCount
  })
})
</script>

<template>
  <div class="app-shell">
    <header class="glass-card topbar">
      <span class="logo">🎈 直播弹幕助手</span>
      <span class="stat">⚡ {{ rate }}/分钟</span>
      <span class="stat">👥 {{ online ?? '--' }}</span>
      <button class="btn-cartoon topbar__settings" disabled>⚙ 设置(M3)</button>
    </header>
    <aside class="glass-card sidebar"><RoomPanel /></aside>
    <main class="glass-card feed"><DanmakuList /></main>
    <section class="glass-card reply">
      <h3>🤖 AI 回复面板</h3>
      <p class="reply__hint">AI 回复引擎将在 M3 接入（智谱 GLM）</p>
    </section>
    <footer class="glass-card statusbar">
      房间数 {{ rooms.rooms.length }} ｜ 弹幕 {{ danmaku.items.length }} 条 ｜ 模式：B站 WS Hook
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: grid; height: 100%; gap: 10px; padding: 10px;
  grid-template-columns: 230px 1fr 300px;
  grid-template-rows: 52px 1fr 32px;
  grid-template-areas: 'top top top' 'side feed reply' 'status status status';
}
.topbar { grid-area: top; display: flex; align-items: center; gap: 16px; padding: 0 16px; font-weight: 700; }
.logo { font-size: 16px; }
.stat { font-size: 13px; }
.topbar__settings { margin-left: auto; }
.sidebar { grid-area: side; }
.feed { grid-area: feed; overflow: hidden; }
.reply { grid-area: reply; padding: 14px; }
.reply__hint { font-size: 12px; opacity: 0.6; margin-top: 8px; }
.statusbar { grid-area: status; display: flex; align-items: center; padding: 0 12px; font-size: 12px; }
</style>
```

- [ ] **Step 7: typecheck + 手动冒烟（真实房间）**

Run: `npm run typecheck` → exit 0
Run: `npm run dev` → 在左栏输入一个正在直播的 B 站房间号 → Expected: 状态变「在线」，弹幕数秒级刷出；标题栏出现「兜底」标签时说明走了 DOM 模式（检查 watchdog 逻辑）。若无弹幕：打开主进程控制台看 `[wv]` 日志排查。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/
git commit -m "feat(m2): 弹幕流UI(房间管理/气泡着色/自动滚动/速率展示)"
```

---

### Task 12: 全量验证与里程碑收尾

- [ ] **Step 1: 全量测试与类型检查**

```bash
npm test
npm run typecheck
```
Expected: 全部 PASS、exit 0

- [ ] **Step 2: 生产构建验证**

```bash
npm run build
```
Expected: `out/` 产出 main/preload/renderer 三端产物，无错误。

- [ ] **Step 3: Commit（如有收尾修正）**

```bash
git add -A
git commit -m "chore(m2): M1+M2 里程碑收尾验证"
```

---

## 验收标准（本计划完成时）

1. `npm run dev` 启动应用，卡通磨砂 UI 完整呈现（糖果渐变/磨砂卡片/2px 描边/硬阴影/6px 圆角）。
2. 添加 B 站直播间后 ≤10 秒进入 `connected` 或 `fallback-dom` 状态，弹幕以统一结构（用户+内容）实时上屏。
3. `npm test` 全绿：协议解包 5 用例 + 消息映射 5 用例。
4. `npm run build` 生产构建成功。
