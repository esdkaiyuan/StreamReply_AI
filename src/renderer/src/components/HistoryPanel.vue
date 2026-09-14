<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { DanmakuMessage, HistoryDanmaku, HistoryReply } from '../../../shared/types'
import { useRoomStore } from '../stores/rooms'
import DanmakuItem from './DanmakuItem.vue'

const rooms = useRoomStore()
const kind = ref<'danmaku' | 'replies'>('danmaku')
const roomId = ref('')
const keyword = ref('')
const loading = ref(false)
const available = ref(true)
const danmaku = ref<HistoryDanmaku[]>([])
const replies = ref<HistoryReply[]>([])
const limit = ref(100)

const PAGE = 50

const empty = computed(() =>
  kind.value === 'danmaku' ? danmaku.value.length === 0 : replies.value.length === 0
)
const canLoadMore = computed(() => {
  const n = kind.value === 'danmaku' ? danmaku.value.length : replies.value.length
  return available.value && n >= limit.value
})

/** 历史弹幕转成实时列表用的结构，复用同一套气泡样式 */
function toMessage(r: HistoryDanmaku): DanmakuMessage {
  return {
    id: r.id,
    platform: r.platform,
    roomId: r.roomId,
    type: r.type,
    user: { uid: r.uid, nickname: r.nickname },
    content: r.content,
    ts: r.ts,
    source: r.source
  }
}

async function search(reset = true): Promise<void> {
  if (loading.value) return
  loading.value = true
  if (reset) limit.value = PAGE
  try {
    const q = {
      roomId: roomId.value || undefined,
      keyword: keyword.value.trim() || undefined,
      limit: limit.value
    }
    if (kind.value === 'danmaku') {
      const res = await window.lda.queryDanmaku(q)
      available.value = res.available
      danmaku.value = res.items
    } else {
      const res = await window.lda.queryReplies(q)
      available.value = res.available
      replies.value = res.items
    }
  } finally {
    loading.value = false
  }
}

function loadMore(): void {
  limit.value += PAGE
  void search(false)
}

function fmt(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

onMounted(async () => {
  await rooms.refresh()
  await search()
})
</script>

<template>
  <div class="hp">
    <div class="hp-bar">
      <select v-model="kind" class="input-cartoon" @change="search()">
        <option value="danmaku">弹幕记录</option>
        <option value="replies">回复记录</option>
      </select>
      <select v-model="roomId" class="input-cartoon hp-room" @change="search()">
        <option value="">全部房间</option>
        <option v-for="r in rooms.rooms" :key="r.roomId" :value="r.roomId">{{ r.roomId }}</option>
      </select>
      <input
        v-model="keyword"
        class="input-cartoon hp-kw"
        placeholder="按昵称/内容搜索"
        @keyup.enter="search()"
      />
      <button class="btn-cartoon" :disabled="loading" @click="search()">
        {{ loading ? '…' : '查询' }}
      </button>
    </div>

    <p v-if="!available" class="hp-note">
      历史库不可用：本地数据库文件打开失败，弹幕未落盘。可查看主进程日志确认原因。
    </p>

    <div class="hp-list">
      <template v-if="kind === 'danmaku'">
        <DanmakuItem v-for="r in danmaku" :key="r.id" :msg="toMessage(r)" :actionable="false" />
      </template>
      <template v-else>
        <div v-for="r in replies" :key="r.id" class="hp-reply">
          <div class="hp-reply__head">
            <span class="hp-reply__to">→ {{ r.replyTo }}</span>
            <span class="hp-reply__status" :data-status="r.status">{{ r.status }}</span>
            <span class="hp-reply__time">{{ fmt(r.sentAt ?? r.createdAt) }}</span>
          </div>
          <div class="hp-reply__text">{{ r.text }}</div>
        </div>
      </template>
      <p v-if="empty && available" class="hp-note">没有匹配的记录</p>
    </div>

    <button v-if="canLoadMore" class="btn-cartoon hp-more" :disabled="loading" @click="loadMore">
      加载更多
    </button>
  </div>
</template>

<style scoped>
.hp { display: flex; flex-direction: column; height: 100%; padding: 10px 12px; gap: 8px; }
.hp-bar { display: flex; gap: 6px; }
.hp-room { width: 110px; }
.hp-kw { flex: 1; min-width: 0; }
.hp-list { flex: 1; overflow-y: auto; }
.hp-note { font-size: 12px; opacity: 0.6; line-height: 1.6; }
.hp-note code { font-size: 11px; background: rgba(255, 255, 255, 0.7); padding: 0 4px; border-radius: 3px; }
.hp-reply {
  border: var(--border-bold); border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.7); padding: 8px; margin-bottom: 6px;
}
.hp-reply__head { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.hp-reply__to { font-weight: 700; }
.hp-reply__status { border: 1px solid var(--ink); border-radius: 3px; padding: 0 4px; }
.hp-reply__status[data-status='failed'] { background: #ffe0e0; }
.hp-reply__status[data-status='sent'] { background: #d8f7e8; }
.hp-reply__time { margin-left: auto; opacity: 0.55; }
.hp-reply__text { font-size: 13px; margin-top: 3px; word-break: break-all; }
.hp-more { align-self: center; font-size: 12px; padding: 3px 14px; }
</style>
