<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ReplySnapshot, ReplyTask } from '../../../shared/types'
import { useSettingsStore } from '../stores/settings'

const settings = useSettingsStore()
const snap = ref<ReplySnapshot>({ queue: [], history: [], sentLastMinute: 0, sentLastHour: 0 })

const EMOTION_ICON: Record<string, string> = {
  answer: '💬',
  thanks: '🎁',
  greet: '👋',
  tease: '😜',
  comfort: '🫶'
}
const STATUS_LABEL: Record<string, string> = {
  'pending-confirm': '待确认',
  queued: '排队中',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  rejected: '已弃用'
}

const aiOn = computed(() => settings.s?.aiEnabled ?? false)
const pending = computed(() => snap.value.history.filter((t) => t.status === 'pending-confirm'))
const done = computed(() => snap.value.history.filter((t) => t.status !== 'pending-confirm'))

onMounted(() => {
  void settings.load()
  window.lda.onReplyUpdate((s) => (snap.value = s))
})

function toggleAi(): void {
  void settings.toggleAi()
}
function confirm(id: string): void {
  void window.lda.confirmReply(id)
}
function reject(id: string): void {
  void window.lda.rejectReply(id)
}
function retry(id: string): void {
  void window.lda.retryReply(id)
}
function icon(t: ReplyTask): string {
  return EMOTION_ICON[t.emotion] ?? '💬'
}
function statusText(t: ReplyTask): string {
  return STATUS_LABEL[t.status] ?? t.status
}
</script>

<template>
  <div class="reply-panel">
    <div class="reply-head">
      <h3>🤖 AI 回复</h3>
      <button class="btn-cartoon" :class="{ 'ai-off': !aiOn }" @click="toggleAi">
        {{ aiOn ? 'AI 已开启' : 'AI 已关闭' }}
      </button>
    </div>
    <p class="reply-stat">⚡ 已发送 {{ snap.sentLastMinute }}/分钟 · {{ snap.sentLastHour }}/小时</p>

    <div class="reply-scroll">
      <h4>待确认（{{ pending.length }}）</h4>
      <div v-for="t in pending" :key="t.id" class="reply-card" :data-emotion="t.emotion">
        <div class="reply-text">{{ icon(t) }} → {{ t.replyTo }}：{{ t.text }}</div>
        <div class="reply-actions">
          <button class="btn-cartoon" @click="confirm(t.id)">✓ 发送</button>
          <button class="btn-cartoon reply-reject" @click="reject(t.id)">✗ 弃用</button>
        </div>
      </div>
      <p v-if="!pending.length" class="reply-empty">暂无待确认回复</p>

      <h4>发送队列（{{ snap.queue.length }}）</h4>
      <div v-for="t in snap.queue" :key="t.id" class="reply-card" :data-emotion="t.emotion">
        <div class="reply-text">{{ icon(t) }} → {{ t.replyTo }}：{{ t.text }}</div>
        <span class="reply-status">{{ statusText(t) }}</span>
      </div>
      <p v-if="!snap.queue.length" class="reply-empty">队列为空</p>

      <h4>历史（{{ done.length }}）</h4>
      <div v-for="t in done" :key="t.id" class="reply-card reply-card--done">
        <div class="reply-text">{{ icon(t) }} → {{ t.replyTo }}：{{ t.text }}</div>
        <button v-if="t.status === 'failed'" class="btn-cartoon reply-retry" @click="retry(t.id)">
          重试
        </button>
        <span v-else class="reply-status">{{ statusText(t) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reply-panel { display: flex; flex-direction: column; height: 100%; padding: 12px; gap: 6px; }
.reply-head { display: flex; align-items: center; justify-content: space-between; }
.reply-head h3 { font-size: 14px; }
.ai-off { background: #b9b9c9; }
.reply-stat { font-size: 12px; opacity: 0.7; }
.reply-scroll { overflow-y: auto; flex: 1; }
h4 { font-size: 12px; margin: 8px 0 4px; opacity: 0.75; }
.reply-empty { font-size: 12px; opacity: 0.5; margin-bottom: 4px; }
.reply-card {
  border: var(--border-bold);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.7);
  padding: 8px;
  margin-bottom: 6px;
  font-size: 13px;
}
.reply-card[data-emotion='thanks'] { background: var(--c-gift); }
.reply-card--done { opacity: 0.78; background: rgba(255, 255, 255, 0.5); }
.reply-actions { display: flex; gap: 6px; margin-top: 6px; }
.reply-reject { background: #e05656; }
.reply-retry { margin-top: 6px; padding: 2px 10px; font-size: 12px; }
.reply-status { font-size: 11px; opacity: 0.6; }
</style>
