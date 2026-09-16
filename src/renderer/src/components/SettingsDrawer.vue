<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { AppSettings, TriggerMode } from '../../../shared/types'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'

const store = useSettingsStore()
const ui = useUiStore()
const open = ref(false)
const form = ref<AppSettings | null>(null)
const keywordsText = ref('')
const sensitiveText = ref('')

// 通知主进程隐藏直播画面（原生层会盖住抽屉）
watch(open, (v) => (v ? ui.openModal() : ui.closeModal()))
onUnmounted(() => {
  if (open.value) ui.closeModal()
})

const TRIGGERS: Array<{ v: TriggerMode; label: string }> = [
  { v: 'smart', label: '智能模式（AI 自行判断）' },
  { v: 'keyword', label: '仅关键词' },
  { v: 'question', label: '仅提问' },
  { v: 'all', label: '全部回复（不推荐）' }
]

watch(
  () => store.s,
  (s) => {
    if (!s) return
    form.value = { ...s, keywords: [...s.keywords], sensitiveWords: [...s.sensitiveWords] }
    keywordsText.value = s.keywords.join(',')
    sensitiveText.value = s.sensitiveWords.join(',')
  },
  { immediate: true }
)

onMounted(() => void store.load())

function splitList(text: string): string[] {
  return text
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function save(): Promise<void> {
  if (!form.value) return
  const patch: Partial<AppSettings> = {
    glmBaseUrl: form.value.glmBaseUrl.trim(),
    glmModel: form.value.glmModel.trim(),
    glmApiKey: form.value.glmApiKey.trim(),
    persona: form.value.persona,
    triggerMode: form.value.triggerMode,
    keywords: splitList(keywordsText.value),
    sensitiveWords: splitList(sensitiveText.value),
    requireConfirm: form.value.requireConfirm,
    maxPerMinute: Math.min(Math.max(form.value.maxPerMinute, 1), 10),
    maxPerHour: Math.min(Math.max(form.value.maxPerHour, 1), 200)
  }
  await store.save(patch)
  open.value = false
}
</script>

<template>
  <button class="btn-cartoon" @click="open = true">⚙ 设置</button>
  <Teleport to="body">
    <div v-if="open" class="drawer-mask" @click.self="open = false">
      <div class="drawer glass-card">
        <h3>⚙ 设置</h3>
        <template v-if="form">
          <label>GLM BaseURL<input v-model="form.glmBaseUrl" class="input-cartoon" /></label>
          <label>模型<input v-model="form.glmModel" class="input-cartoon" /></label>
          <label>
            API Key（留空则沿用 .env.local）
            <input v-model="form.glmApiKey" class="input-cartoon" type="password" />
          </label>
          <label>人设 Prompt<textarea v-model="form.persona" class="input-cartoon" rows="3" /></label>
          <label>
            触发模式
            <select v-model="form.triggerMode" class="input-cartoon">
              <option v-for="t in TRIGGERS" :key="t.v" :value="t.v">{{ t.label }}</option>
            </select>
          </label>
          <label>关键词（逗号分隔）<input v-model="keywordsText" class="input-cartoon" /></label>
          <label>敏感词（逗号分隔）<input v-model="sensitiveText" class="input-cartoon" /></label>
          <label class="row">
            <input v-model="form.requireConfirm" type="checkbox" />
            <span>发送前人工确认</span>
          </label>
          <label>
            每分钟上限
            <input v-model.number="form.maxPerMinute" class="input-cartoon" type="number" min="1" max="10" />
          </label>
          <label>
            每小时上限
            <input v-model.number="form.maxPerHour" class="input-cartoon" type="number" min="1" />
          </label>
        </template>
        <p v-else class="hint">加载中…</p>
        <div class="drawer-actions">
          <button class="btn-cartoon" @click="save">保存</button>
          <button class="btn-cartoon" @click="open = false">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(43, 43, 58, 0.35);
  display: grid;
  place-items: center;
}
.drawer {
  width: 460px;
  max-height: 85vh;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
h3 { font-size: 15px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
label.row { flex-direction: row; align-items: center; gap: 6px; }
.drawer-actions { display: flex; gap: 8px; margin-top: 4px; }
.hint { font-size: 13px; opacity: 0.6; }
</style>
