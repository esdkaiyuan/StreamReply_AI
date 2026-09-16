<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
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

const wrap = ref<HTMLElement | null>(null)
const slot = ref<HTMLElement | null>(null)
const selected = ref('')
const collapsed = ref(false)
/** 拖拽后的自定义高度；null 表示按 16:9 自适应 */
const manualHeight = ref<number | null>(null)
const autoHeight = ref(240)
const dragging = ref(false)

const candidates = computed(() => rooms.rooms.filter((r) => r.status !== 'closed'))
const height = computed(() => manualHeight.value ?? autoHeight.value)

const MIN_H = 120

/**
 * 默认高度取「栏宽 × 9/16」，正好贴合 16:9 不留黑边；
 * 上限为「窗口高度 - 240px」，给弹幕列表与工具栏留出空间。
 * （不要用父元素的 clientHeight：父级是 .vp 自身，高度由本面板决定，会算成死循环）
 */
function recomputeAuto(): void {
  const w = wrap.value?.clientWidth ?? 0
  if (!w) return
  const byRatio = Math.round((w * 9) / 16)
  const cap = Math.round(window.innerHeight) - 240
  autoHeight.value = Math.max(MIN_H, Math.min(byRatio, cap))
}

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
// 高度变化会改变原生视图的位置，等 DOM 生效后再上报
watch(height, async () => {
  await nextTick()
  send()
})

let observer: ResizeObserver | null = null
onMounted(async () => {
  await rooms.refresh()
  recomputeAuto()
  if (wrap.value) {
    observer = new ResizeObserver(() => {
      recomputeAuto()
      sendThrottled()
    })
    observer.observe(wrap.value)
  }
  window.addEventListener('resize', onWindowResize)
  send()
})

onUnmounted(() => {
  observer?.disconnect()
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('mousemove', onGripMove)
  window.removeEventListener('mouseup', onGripUp)
  if (raf) cancelAnimationFrame(raf)
  window.lda.setVideoTarget(null, null)
})

function onWindowResize(): void {
  recomputeAuto()
  sendThrottled()
}

/** 拖拽下边缘调整画面高度；双击恢复 16:9 自适应 */
let dragStartY = 0
let dragStartH = 0

function onGripDown(e: MouseEvent): void {
  dragging.value = true
  dragStartY = e.clientY
  dragStartH = height.value
  window.addEventListener('mousemove', onGripMove)
  window.addEventListener('mouseup', onGripUp)
  e.preventDefault()
}

function onGripMove(e: MouseEvent): void {
  const next = dragStartH + (e.clientY - dragStartY)
  manualHeight.value = Math.max(MIN_H, Math.min(next, Math.round(window.innerHeight * 0.7)))
}

function onGripUp(): void {
  dragging.value = false
  window.removeEventListener('mousemove', onGripMove)
  window.removeEventListener('mouseup', onGripUp)
  send()
}

function resetHeight(): void {
  manualHeight.value = null
  recomputeAuto()
}
</script>

<template>
  <section class="vp" :class="{ dragging }">
    <div ref="wrap" class="vp-wrap">
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
        <span v-if="!collapsed && candidates.length" class="vp-hint">
          仅当前房间出声 ｜ 按原比例自适应（拖下边缘调高，双击复位）
        </span>
      </div>
      <div v-show="!collapsed" ref="slot" class="vp-slot" :style="{ height: height + 'px' }">
        <p v-if="!candidates.length" class="vp-empty">
          添加直播间后这里会显示画面<br />
          <span class="vp-sub">（只保留播放器，页面其他区块已隐藏）</span>
        </p>
      </div>
      <div v-if="!collapsed" class="vp-grip" @mousedown="onGripDown" @dblclick="resetHeight" />
    </div>
  </section>
</template>

<style scoped>
.vp { flex: 0 0 auto; }
.vp.dragging { user-select: none; }
.vp-wrap { display: flex; flex-direction: column; gap: 6px; }
.vp-head { display: flex; align-items: center; gap: 8px; }
.vp-toggle {
  font: inherit; font-size: 12px; font-weight: 700; padding: 2px 10px; cursor: pointer;
  border: 1.5px solid var(--ink); border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.6);
}
.vp-room { width: 150px; font-size: 12px; }
.vp-hint { font-size: 11px; opacity: 0.5; }
.vp-slot {
  display: grid;
  place-items: center;
  background: #000;
  border: 1.5px solid var(--ink);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.vp-empty { color: #cfcfe0; font-size: 12.5px; text-align: center; line-height: 1.8; }
.vp-sub { opacity: 0.55; font-size: 11px; }
/* 拖拽手柄：贴着画面下边缘 */
.vp-grip {
  height: 8px; margin-top: -4px; cursor: ns-resize; position: relative; z-index: 2;
  display: flex; align-items: center; justify-content: center;
}
.vp-grip::after {
  content: ''; width: 46px; height: 3px; border-radius: 2px;
  background: rgba(43, 43, 58, 0.35);
}
.vp-grip:hover::after { background: var(--accent); }
</style>
