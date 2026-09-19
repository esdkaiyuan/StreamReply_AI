<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Platform, PlatformAccountSnapshot } from '../../../shared/types'
import { useRoomStore } from '../stores/rooms'

const store = useRoomStore()
const input = ref('')
const platform = ref<Platform | 'auto'>('auto')
const error = ref('')

const STATUS_LABEL: Record<string, string> = {
  idle: '待机', loading: '连接中…', connected: '在线',
  'fallback-dom': '兜底模式', error: '异常', closed: '已关闭'
}
const STATUS_DOT: Record<string, string> = {
  connected: '#4caf7d', loading: '#f0a742', 'fallback-dom': '#f0a742',
  error: '#e05656', idle: '#999', closed: '#999'
}
const PLATFORM_LABEL: Record<string, string> = {
  bilibili: 'B站', douyin: '抖音', kuaishou: '快手', douyu: '斗鱼', huya: '虎牙'
}

/**
 * 虎牙游客态没有聊天身份：弹幕区不初始化（列表只有系统公告）、无输入框。
 * 实测（2026-09-19）：登录虎牙后弹幕区才会挂载。这里有虎牙房间且未登录时给出明确引导。
 */
const huyaSnap = ref<PlatformAccountSnapshot | null>(null)
async function refreshHuyaLogin(): Promise<void> {
  try {
    huyaSnap.value = (await window.lda.getPlatformAccounts('huya')) as PlatformAccountSnapshot
  } catch {
    /* 忽略 */
  }
}
const huyaRoomExists = computed(() => store.rooms.some((r) => r.platform === 'huya'))
const huyaNeedLogin = computed(() => huyaRoomExists.value && huyaSnap.value?.isLogin === false)

const PLATFORMS: Array<{ value: Platform | 'auto'; label: string }> = [
  { value: 'auto', label: '自动识别' },
  { value: 'bilibili', label: 'B站' },
  { value: 'douyin', label: '抖音' },
  { value: 'kuaishou', label: '快手' },
  { value: 'douyu', label: '斗鱼' },
  { value: 'huya', label: '虎牙' }
]

async function add(): Promise<void> {
  error.value = ''
  const res = await store.add(input.value, platform.value === 'auto' ? undefined : platform.value)
  if (!res.ok) error.value = res.error ?? '添加失败'
  else input.value = ''
}

onMounted(() => {
  void store.refresh()
  void refreshHuyaLogin()
  window.lda.onRoomStatus((r) => store.applyStatus(r))
})

watch(huyaRoomExists, (v) => {
  if (v) void refreshHuyaLogin()
})
</script>

<template>
  <div class="room-panel">
    <div class="room-add">
      <select v-model="platform" class="input-cartoon room-platform">
        <option v-for="p in PLATFORMS" :key="p.value" :value="p.value">{{ p.label }}</option>
      </select>
      <input
        v-model="input"
        class="input-cartoon room-input"
        placeholder="直播间地址 / 房间号（快手填 /u/ 后的 ID）"
        @keydown.enter="add"
      />
      <button class="btn-cartoon" @click="add">添加</button>
      <p v-if="error" class="room-error">{{ error }}</p>
    </div>
    <p v-if="huyaNeedLogin" class="room-tip">
      💡 虎牙游客态收不到弹幕：请点顶栏「👤 账号信息」登录虎牙后重新添加房间
    </p>
    <ul class="room-list">
      <li v-for="r in store.rooms" :key="r.roomId" class="room-row">
        <span class="room-dot" :style="{ background: STATUS_DOT[r.status] }" />
        <span class="room-id">{{ PLATFORM_LABEL[r.platform] ?? r.platform }} {{ r.roomId }}</span>
        <span class="room-status">
          {{ STATUS_LABEL[r.status] }}
          <b v-if="store.counts[r.roomId] !== undefined" class="room-count">
            {{ store.counts[r.roomId] }} 条
          </b>
        </span>
        <button class="room-remove" title="移除" @click="store.remove(r.roomId)">×</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.room-panel { display: flex; flex-direction: column; height: 100%; padding: 12px; gap: 12px; }
.room-add { display: flex; gap: 6px; flex-wrap: wrap; }
.room-platform { width: 100%; }
.room-input { flex: 1 1 100%; }
.room-error { color: #e05656; font-size: 12px; width: 100%; }
.room-list { list-style: none; overflow-y: auto; }
.room-row { display: flex; align-items: center; gap: 6px; padding: 8px; border: 2px solid var(--ink); border-radius: 6px; background: rgba(255,255,255,.6); margin-bottom: 8px; }
.room-dot { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--ink); flex: none; }
.room-id { font-weight: 700; font-size: 13px; }
.room-status { font-size: 11px; opacity: 0.7; margin-left: auto; }
.room-tip {
  font-size: 12px; line-height: 1.6; color: #a35a00;
  background: rgba(255, 167, 66, 0.12); border: 1.5px dashed rgba(240, 167, 66, 0.6);
  border-radius: var(--radius-sm); padding: 6px 10px; margin: 6px 2px 0;
}
.room-count { color: #0a7d43; font-weight: 700; }
.room-remove { border: none; background: none; font-size: 16px; cursor: pointer; color: #e05656; }
</style>
