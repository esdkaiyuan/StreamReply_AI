<script setup lang="ts">
import { onMounted, ref } from 'vue'
import RoomPanel from './components/RoomPanel.vue'
import DanmakuList from './components/DanmakuList.vue'
import ReplyPanel from './components/ReplyPanel.vue'
import SettingsDrawer from './components/SettingsDrawer.vue'
import { useDanmakuStore } from './stores/danmaku'
import { useRoomStore } from './stores/rooms'

const danmaku = useDanmakuStore()
const rooms = useRoomStore()
const rate = ref(0)
const online = ref<number | undefined>(undefined)

onMounted(() => {
  window.lda.onDanmaku((m) => danmaku.push(m))
  window.lda.onRoomStat((s) => {
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
      <div class="topbar__settings"><SettingsDrawer /></div>
    </header>
    <aside class="glass-card sidebar"><RoomPanel /></aside>
    <main class="glass-card feed"><DanmakuList /></main>
    <section class="glass-card reply"><ReplyPanel /></section>
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
.reply { grid-area: reply; overflow: hidden; }
.statusbar { grid-area: status; display: flex; align-items: center; padding: 0 12px; font-size: 12px; }
</style>
