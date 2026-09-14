<script setup lang="ts">
import { useAiStore } from '../stores/ai'

const ai = useAiStore()

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="log-wrap">
    <div class="log-head">
      <span class="log-count">最近 {{ ai.logs.length }} 条</span>
      <button class="log-clear" @click="ai.clear()">清空</button>
    </div>
    <p v-if="!ai.logs.length" class="log-empty">暂无记录。AI 生成、拦截、发送的结果都会显示在这里。</p>
    <div v-for="(e, i) in ai.logs" :key="`${e.ts}-${i}`" class="log-row" :data-level="e.level">
      <span class="log-time">{{ time(e.ts) }}</span>
      <span class="log-msg">{{ e.nickname ? `[${e.nickname}] ` : '' }}{{ e.message }}</span>
    </div>
  </div>
</template>

<style scoped>
.log-wrap { display: flex; flex-direction: column; height: 100%; overflow-y: auto; }
.log-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.log-count { font-size: 11px; opacity: 0.6; }
.log-clear { font: inherit; font-size: 11px; border: none; background: none; color: var(--ink); opacity: 0.6; cursor: pointer; text-decoration: underline; }
.log-empty { font-size: 12px; opacity: 0.5; }
.log-row {
  display: flex; gap: 6px; font-size: 12px; line-height: 1.5;
  padding: 3px 6px; border-radius: 4px; margin-bottom: 3px;
  background: rgba(255, 255, 255, 0.5);
}
.log-row[data-level='warn'] { background: #fff3cd; }
.log-row[data-level='error'] { background: #ffe0e0; }
.log-time { flex: none; opacity: 0.55; font-variant-numeric: tabular-nums; }
.log-msg { word-break: break-all; }
</style>
