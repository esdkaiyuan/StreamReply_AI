<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { VideoRect } from '../../../shared/types'
import { useRoomStore } from '../stores/rooms'
import { useUiStore } from '../stores/ui'

/**
 * 直播画面。
 *
 * 实现要点：画面不是把流地址取出来用 <video> 播放（B 站流派地址带签名与 Referer 校验，
 * 极不稳定），而是把后台那层原生 WebContentsView 直接**搬到这个占位区的坐标上**。
 * 因此这里只做一件事：测量占位区矩形并上报主进程。
 */
const rooms = useRoomStore()
const ui = useUiStore()

const slot = ref<HTMLElement | null>(null)
const selected = ref('')
const collapsed = ref(false)

const candidates = computed(() => rooms.rooms.filter((r) => r.status !== 'closed'))

function measure(): VideoRect | null {
  const el = slot.value
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/** 面板不可见（折叠 / 有弹窗）时不显示画面，避免原生层盖住 UI */
function hidden(): boolean {
  return collapsed.value || ui.modalOpen || !selected.value
}

/**
 * 同步上报（不节流）。
 * 状态变化（切换房间 / 折叠 / 弹窗）必须立刻送达主进程：
 * 用 rAF 节流会在窗口被遮挡或最小化时被暂停，导致「弹窗打开了但画面还盖在上面」。
 */
function send(): void {
  if (hidden()) window.lda.setVideoTarget(null, null)
  else window.lda.setVideoTarget(selected.value, measure())
}

/** 尺寸变化频繁，用 rAF 合并（丢一帧只是位置略滞后，下次可见时会自动纠正） */
let raf = 0
function sendThrottled(): void {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    send()
  })
}

// 房间列表变化时保证选中项有效（默认选第一个可用房间）
watch(
  candidates,
  (list) => {
    if (selected.value && list.some((r) => r.roomId === selected.value)) return
    selected.value = list[0]?.roomId ?? ''
    send()
  },
  { immediate: true }
)

watch([selected, collapsed, () => ui.modalOpen], send)

let observer: ResizeObserver | null = null
onMounted(async () => {
  await rooms.refresh()
  if (slot.value) {
    observer = new ResizeObserver(sendThrottled)
    observer.observe(slot.value)
  }
  window.addEventListener('resize', sendThrottled)
  send()
})

onUnmounted(() => {
  observer?.disconnect()
  window.removeEventListener('resize', sendThrottled)
  if (raf) cancelAnimationFrame(raf)
  window.lda.setVideoTarget(null, null)
})
</script>

<template>
  <section class="vp">
    <div class="vp-head">
      <button class="vp-toggle" @click="collapsed = !collapsed">
        {{ collapsed ? '▶' : '▼' }} 📺 直播画面
      </button>
      <select v-if="!collapsed" v-model="selected" class="input-cartoon vp-room">
        <option value="" disabled>选择房间</option>
        <option v-for="r in candidates" :key="r.roomId" :value="r.roomId">
          {{ r.platform }} · {{ r.roomId }}
        </option>
      </select>
      <span v-if="!collapsed && candidates.length" class="vp-hint">仅当前房间出声</span>
    </div>
    <div v-show="!collapsed" ref="slot" class="vp-slot">
      <p v-if="!candidates.length" class="vp-empty">
        添加直播间后这里会显示画面<br />
        <span class="vp-sub">（画面来自后台已加载的直播间页面，不额外消耗带宽）</span>
      </p>
    </div>
  </section>
</template>

<style scoped>
.vp { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; }
.vp-head { display: flex; align-items: center; gap: 8px; }
.vp-toggle {
  font: inherit; font-size: 12px; font-weight: 700; padding: 2px 10px; cursor: pointer;
  border: 1.5px solid var(--ink); border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.6);
}
.vp-room { width: 150px; font-size: 12px; }
.vp-hint { font-size: 11px; opacity: 0.5; }
.vp-slot {
  height: clamp(150px, 32vh, 360px);
  display: grid;
  place-items: center;
  background: #16161f;
  border: 1.5px solid var(--ink);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.vp-empty { color: #cfcfe0; font-size: 12.5px; text-align: center; line-height: 1.8; }
.vp-sub { opacity: 0.55; font-size: 11px; }
</style>
