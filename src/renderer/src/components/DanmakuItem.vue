<script setup lang="ts">
import { computed, ref } from 'vue'
import type { DanmakuMessage } from '../../../shared/types'
const props = withDefaults(defineProps<{ msg: DanmakuMessage; actionable?: boolean }>(), {
  actionable: true
})

const busy = ref(false)
const canReply = computed(
  () => props.actionable && (props.msg.type === 'chat' || props.msg.type === 'gift')
)

async function askAi(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await window.lda.manualReply(props.msg)
  } finally {
    busy.value = false
  }
}

const cls = computed(() => ({
  chat: 'dm-item--chat',
  enter: 'dm-item--enter',
  gift: 'dm-item--gift',
  like: 'dm-item--chat',
  follow: 'dm-item--chat',
  share: 'dm-item--chat'
}[props.msg.type]))

const isQuestion = computed(() => /[？?]|吗|呢/.test(props.msg.content))
</script>

<template>
  <div class="dm-item glass-card" :class="[cls, { 'dm-item--ask': isQuestion && msg.type === 'chat' }]">
    <span class="dm-avatar">{{ msg.user.nickname.slice(0, 1) }}</span>
    <div class="dm-body">
      <div class="dm-head">
        <span class="dm-name">{{ msg.user.nickname }}</span>
        <span v-if="msg.user.medalLevel" class="dm-medal">Lv{{ msg.user.medalLevel }}</span>
        <span v-if="msg.source === 'dom'" class="dm-tag">兜底</span>
        <button v-if="canReply" class="dm-ask" :disabled="busy" @click="askAi">
          {{ busy ? '生成中…' : 'AI 回复' }}
        </button>
      </div>
      <div class="dm-content">{{ msg.content }}</div>
      <div v-if="msg.type === 'gift'" class="dm-gift">🎁 {{ msg.gift?.name }} × {{ msg.gift?.count }}</div>
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
.dm-ask {
  margin-left: auto; font: inherit; font-size: 11px; padding: 1px 8px;
  background: #fff; color: var(--ink); border: 1.5px solid var(--ink);
  border-radius: 4px; cursor: pointer;
}
.dm-ask:hover { background: var(--accent); color: #fff; }
.dm-ask:disabled { opacity: 0.5; cursor: progress; }
.dm-content { margin-top: 2px; line-height: 1.4; word-break: break-all; }
.dm-gift { font-size: 12px; margin-top: 2px; }
</style>
