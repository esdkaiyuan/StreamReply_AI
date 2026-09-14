<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ReplySnapshot, ReplyTask } from '../../../shared/types'
import { useAiStore } from '../stores/ai'
import { useSettingsStore } from '../stores/settings'
import AiLogList from './AiLogList.vue'
import ManualSendBox from './ManualSendBox.vue'

const settings = useSettingsStore()
const ai = useAiStore()
const snap = ref<ReplySnapshot>({ queue: [], history: [], sentLastMinute: 0, sentLastHour: 0 })
const tab = ref<'queue' | 'log'>('queue')
const editingId = ref('')
const editingText = ref('')

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
const stateHint = computed(() => {
  if (!settings.s) return ''
  if (!settings.s.glmApiKey) return '未配置 GLM API Key，AI 无法生成回复'
  if (!aiOn.value) return 'AI 已关闭，仅记录弹幕；点上方按钮开启'
  return ''
})

onMounted(() => {
  ai.init()
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
function startEdit(t: ReplyTask): void {
  editingId.value = t.id
  editingText.value = t.text
}
function saveEdit(): void {
  if (!editingId.value) return
  void window.lda.editReply(editingId.value, editingText.value.trim())
  editingId.value = ''
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

    <p class="reply-stat">
      ⚡ {{ snap.sentLastMinute }}/分钟 · {{ snap.sentLastHour }}/小时
      <span v-if="ai.state" class="reply-model">{{ ai.state.model }}</span>
    </p>
    <p v-if="stateHint" class="reply-warn">{{ stateHint }}</p>

    <div class="reply-tabs">
      <button :class="{ on: tab === 'queue' }" @click="tab = 'queue'">
        队列（{{ pending.length + snap.queue.length }}）
      </button>
      <button :class="{ on: tab === 'log' }" @click="tab = 'log'">AI 日志（{{ ai.logs.length }}）</button>
    </div>

    <div class="reply-scroll">
      <template v-if="tab === 'queue'">
        <h4>待确认（{{ pending.length }}）</h4>
        <div v-for="t in pending" :key="t.id" class="reply-card" :data-emotion="t.emotion">
          <div v-if="editingId === t.id" class="reply-edit">
            <textarea v-model="editingText" class="input-cartoon" rows="2" maxlength="40" />
            <div class="reply-actions">
              <button class="btn-cartoon" @click="saveEdit">保存</button>
              <button class="btn-cartoon reply-reject" @click="editingId = ''">取消</button>
            </div>
          </div>
          <template v-else>
            <div class="reply-text">{{ icon(t) }} → {{ t.replyTo }}：{{ t.text }}</div>
            <div class="reply-actions">
              <button class="btn-cartoon" @click="confirm(t.id)">✓ 发送</button>
              <button class="btn-cartoon reply-edit-btn" @click="startEdit(t)">编辑</button>
              <button class="btn-cartoon reply-reject" @click="reject(t.id)">✗ 弃用</button>
            </div>
          </template>
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
      </template>
      <AiLogList v-else />
    </div>

    <ManualSendBox />
  </div>
</template>

<style scoped>
.reply-panel { display: flex; flex-direction: column; height: 100%; padding: 12px; gap: 6px; }
.reply-head { display: flex; align-items: center; justify-content: space-between; }
.reply-head h3 { font-size: 14px; }
.ai-off { background: #b9b9c9; }
.reply-stat { font-size: 12px; opacity: 0.7; display: flex; align-items: center; gap: 6px; }
.reply-model { margin-left: auto; font-size: 11px; opacity: 0.7; }
.reply-warn {
  font-size: 11px; line-height: 1.5; background: #fff3cd;
  border: 1.5px solid var(--ink); border-radius: var(--radius-sm); padding: 4px 6px;
}
.reply-tabs { display: flex; gap: 4px; }
.reply-tabs button {
  flex: 1; font: inherit; font-size: 12px; padding: 3px 0; cursor: pointer;
  border: 1.5px solid var(--ink); border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.6);
}
.reply-tabs button.on { background: var(--accent); color: #fff; }
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
.reply-edit { display: flex; flex-direction: column; gap: 6px; }
.reply-edit textarea { width: 100%; resize: vertical; font-size: 13px; }
.reply-edit-btn { background: #7ec8ff; }
.reply-reject { background: #e05656; }
.reply-retry { margin-top: 6px; padding: 2px 10px; font-size: 12px; }
.reply-status { font-size: 11px; opacity: 0.6; }
</style>
