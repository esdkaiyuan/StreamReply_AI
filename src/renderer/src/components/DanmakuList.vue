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
