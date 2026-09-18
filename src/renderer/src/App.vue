<script setup lang="ts">
import { onMounted, ref } from 'vue'
import RoomPanel from './components/RoomPanel.vue'
import DanmakuList from './components/DanmakuList.vue'
import ReplyPanel from './components/ReplyPanel.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import AccountPanel from './components/AccountPanel.vue'
import { useUiStore } from './stores/ui'
import VideoPanel from './components/VideoPanel.vue'
import { useAiStore } from './stores/ai'
import { useDanmakuStore } from './stores/danmaku'
import { useRoomStore } from './stores/rooms'

const danmaku = useDanmakuStore()
const rooms = useRoomStore()
const ai = useAiStore()
const uiStore = useUiStore()
const rate = ref(0)
const online = ref<number | undefined>(undefined)
const feedTab = ref<'live' | 'history'>('live')
const PLATFORMS = [
  { key: 'bilibili', label: 'B站' },
  { key: 'douyin', label: '抖音' },
  { key: 'douyu', label: '斗鱼' },
  { key: 'huya', label: '虎牙' },
  { key: 'kuaishou', label: '快手' }
] as const

onMounted(() => {
  ai.init()
  window.lda.onDanmaku((m) => danmaku.push(m))
  window.lda.onRoomStat((s) => {
    rate.value = s.danmakuRate
    if (s.onlineCount) online.value = s.onlineCount
    if (s.danmakuCount !== undefined) rooms.setCount(s.roomId, s.danmakuCount)
  })
})
</script>

<template>
  <div class="app-shell">
    <header class="glass-card topbar">
      <span class="logo">🎈 直播弹幕助手</span>
      <select
        class="input-cartoon platform-select"
        :value="uiStore.activePlatform"
        @change="uiStore.setActivePlatform(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="p in PLATFORMS" :key="p.key" :value="p.key">{{ p.label }}账号</option>
      </select>
      <span class="stat">⚡ {{ rate }}/分钟</span>
      <span class="stat">👥 {{ online ?? '--' }}</span>
      <div class="topbar__settings">
        <AccountPanel />
        <SettingsDrawer />
      </div>
    </header>
    <aside class="glass-card sidebar"><RoomPanel /></aside>
    <main class="glass-card feed">
      <VideoPanel />
      <div class="feed-tabs">
        <button :class="{ on: feedTab === 'live' }" @click="feedTab = 'live'">实时弹幕</button>
        <button :class="{ on: feedTab === 'history' }" @click="feedTab = 'history'">历史记录</button>
      </div>
      <div class="feed-body">
        <DanmakuList v-if="feedTab === 'live'" />
        <HistoryPanel v-else />
      </div>
    </main>
    <section class="glass-card reply"><ReplyPanel /></section>
    <footer class="glass-card statusbar">
      房间数 {{ rooms.rooms.length }} ｜ 弹幕 {{ danmaku.items.length }} 条 ｜
      {{ ai.state?.dbAvailable ? '历史落盘：开' : '历史落盘：不可用' }} ｜ 抓取：B站主进程直连
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
.topbar__settings { margin-left: auto; display: flex; gap: 8px; }
.sidebar { grid-area: side; }
.feed { grid-area: feed; overflow: hidden; display: flex; flex-direction: column; gap: 6px; padding: 8px; }
.feed-tabs { display: flex; gap: 6px; }
.feed-tabs button {
  font: inherit; font-size: 12px; padding: 3px 12px; cursor: pointer;
  border: 1.5px solid var(--ink); border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.6);
}
.feed-tabs button.on { background: var(--accent); color: #fff; }
.feed-body { flex: 1; min-height: 0; }
.reply { grid-area: reply; overflow: hidden; }
.statusbar { grid-area: status; display: flex; align-items: center; padding: 0 12px; font-size: 12px; }
.platform-select { width: auto; min-width: 96px; font-size: 12.5px; padding: 4px 8px; }
</style>
