<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoomStore } from '../stores/rooms'

const rooms = useRoomStore()
const roomId = ref('')
const text = ref('')
const sending = ref(false)
const hint = ref('')

const online = computed(() => rooms.rooms.filter((r) => r.status !== 'closed'))

onMounted(async () => {
  await rooms.refresh()
  if (!roomId.value && online.value.length) roomId.value = online.value[0].roomId
})

async function send(): Promise<void> {
  const content = text.value.trim()
  if (!roomId.value || !content || sending.value) return
  sending.value = true
  try {
    const res = await window.lda.manualSend(roomId.value, content)
    if (res.ok) {
      text.value = ''
      hint.value = '已发送'
    } else {
      hint.value = `发送失败：${res.reason ?? '未知原因'}`
    }
  } finally {
    sending.value = false
    setTimeout(() => (hint.value = ''), 4000)
  }
}
</script>

<template>
  <div class="ms-box">
    <div class="ms-row">
      <select v-model="roomId" class="input-cartoon ms-room">
        <option value="" disabled>选择房间</option>
        <option v-for="r in online" :key="r.roomId" :value="r.roomId">
          {{ r.platform }} · {{ r.roomId }}
        </option>
      </select>
      <input
        v-model="text"
        class="input-cartoon ms-input"
        placeholder="手动发送一条弹幕"
        maxlength="40"
        @keyup.enter="send"
      />
      <button class="btn-cartoon" :disabled="sending || !roomId || !text.trim()" @click="send">
        {{ sending ? '…' : '发送' }}
      </button>
    </div>
    <p v-if="hint" class="ms-hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.ms-box { border-top: 2px solid var(--ink); padding-top: 8px; }
.ms-row { display: flex; gap: 6px; }
.ms-room { width: 96px; font-size: 12px; }
.ms-input { flex: 1; min-width: 0; }
.ms-hint { font-size: 11px; margin-top: 4px; opacity: 0.75; word-break: break-all; }
</style>
