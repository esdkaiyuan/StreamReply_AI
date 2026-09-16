<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { LoginState, QrPhase } from '../../../shared/types'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
const open = ref(false)
const tab = ref<'qr' | 'cookie'>('qr')
const state = ref<LoginState | null>(null)
const qrImage = ref('')
const qrPhase = ref<QrPhase | 'idle'>('idle')
const qrMessage = ref('')
const cookieText = ref('')
const cookieError = ref('')
const busy = ref(false)
let qrKey = ''
let timer: ReturnType<typeof setInterval> | null = null

const PHASE_TEXT: Record<string, string> = {
  idle: '点击下方按钮生成二维码',
  'waiting-scan': '请用 B 站手机客户端扫码',
  scanned: '已扫码，请在手机上确认',
  confirmed: '登录成功',
  expired: '二维码已过期，请重新生成',
  error: '出错了'
}

const label = computed(() => {
  const s = state.value
  if (!s) return '👤 账号'
  if (s.isLogin) return `👤 ${s.uname || '已登录'}`
  return '👤 未登录'
})

function stopPolling(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

async function refresh(): Promise<void> {
  state.value = await window.lda.getLoginState()
}

async function startQr(): Promise<void> {
  busy.value = true
  cookieError.value = ''
  stopPolling()
  try {
    const res = await window.lda.startQrLogin()
    if (!res.ok) {
      qrPhase.value = 'error'
      qrMessage.value = res.error
      return
    }
    qrImage.value = res.session.qrDataUrl
    qrKey = res.session.key
    qrPhase.value = 'waiting-scan'
    qrMessage.value = ''
    timer = setInterval(poll, 2000)
  } finally {
    busy.value = false
  }
}

async function poll(): Promise<void> {
  if (!qrKey) return
  const res = await window.lda.pollQrLogin(qrKey)
  qrPhase.value = res.phase
  qrMessage.value = res.message ?? ''
  if (res.phase === 'confirmed') {
    stopPolling()
    state.value = res.state ?? null
    qrImage.value = ''
  } else if (res.phase === 'expired' || res.phase === 'error') {
    stopPolling()
  }
}

async function submitCookie(): Promise<void> {
  busy.value = true
  cookieError.value = ''
  try {
    const res = await window.lda.loginWithCookie(cookieText.value)
    if (res.isLogin) {
      state.value = res
      cookieText.value = ''
      cookieError.value = ''
    } else {
      cookieError.value = res.error ?? '登录失败'
    }
  } finally {
    busy.value = false
  }
}

async function openWindow(): Promise<void> {
  await window.lda.openLoginWindow()
}

async function doLogout(): Promise<void> {
  state.value = await window.lda.logout()
  qrImage.value = ''
  qrPhase.value = 'idle'
}

async function show(): Promise<void> {
  open.value = true
  await refresh()
}

onUnmounted(stopPolling)

// 通知主进程隐藏直播画面（原生层会盖住弹窗）
watch(open, (v) => (v ? ui.openModal() : ui.closeModal()))
onUnmounted(() => {
  if (open.value) ui.closeModal()
})
</script>

<template>
  <button class="btn-cartoon" @click="show">{{ label }}</button>
  <Teleport to="body">
    <div v-if="open" class="mask" @click.self="open = false">
      <div class="dialog glass-card">
        <h3>👤 B 站账号</h3>

        <p v-if="state?.isLogin" class="ok">
          已登录：<b>{{ state.uname }}</b>（uid {{ state.uid }}）
          <button class="btn-cartoon sm" @click="doLogout">退出登录</button>
        </p>
        <p v-else class="warn">
          未登录 —— 弹幕<b>抓取</b>不需要登录；但<b>发送</b>弹幕必须登录（游客态页面没有输入框）。
        </p>
        <p v-if="state?.isLogin && state.missingCookies?.length" class="warn">
          ⚠️ 缺少 <b>{{ state.missingCookies.join('、') }}</b>：可正常收弹幕，但<b>发送会被 B 站拒绝</b>。
          请用「打开 B 站登录窗口」重新登录一次以补齐。
        </p>

        <div class="tabs">
          <button :class="{ on: tab === 'qr' }" @click="tab = 'qr'">扫码登录</button>
          <button :class="{ on: tab === 'cookie' }" @click="tab = 'cookie'">Cookie 登录</button>
        </div>

        <template v-if="tab === 'qr'">
          <div class="qr">
            <img v-if="qrImage" :src="qrImage" alt="登录二维码" width="200" height="200" />
            <div v-else class="qr-ph">二维码</div>
          </div>
          <p class="hint">{{ qrMessage || PHASE_TEXT[qrPhase] }}</p>
          <button class="btn-cartoon" :disabled="busy" @click="startQr">
            {{ qrImage ? '重新生成' : '生成二维码' }}
          </button>
        </template>

        <template v-else>
          <label>
            粘贴 B 站 Cookie（至少含 SESSDATA）
            <textarea
              v-model="cookieText"
              class="input-cartoon"
              rows="4"
              placeholder="SESSDATA=xxx; bili_jct=yyy; DedeUserID=zzz"
            />
          </label>
          <p class="hint">
            浏览器登录 bilibili.com → F12 → Application → Cookies → 复制 SESSDATA / bili_jct /
            DedeUserID 三项即可
          </p>
          <p v-if="cookieError" class="err">{{ cookieError }}</p>
          <button class="btn-cartoon" :disabled="busy || !cookieText.trim()" @click="submitCookie">
            校验并登录
          </button>
        </template>

        <hr />
        <p class="hint">扫码/粘贴失败时，可直接在官方登录页登录（登录成功后窗口自动关闭）</p>
        <div class="actions">
          <button class="btn-cartoon" @click="openWindow">打开 B 站登录窗口</button>
          <button class="btn-cartoon" @click="open = false">关闭</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; background: rgba(43, 43, 58, 0.35);
  display: grid; place-items: center; z-index: 20;
}
.dialog {
  width: 420px; max-height: 86vh; overflow-y: auto; padding: 20px;
  display: flex; flex-direction: column; gap: 10px;
}
h3 { font-size: 15px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
p { font-size: 12.5px; line-height: 1.6; }
.ok { color: #0a7d43; }
.warn { color: #a35a00; }
.err { color: #c0392b; }
.hint { opacity: 0.65; }
.tabs { display: flex; gap: 6px; }
.tabs button {
  font: inherit; font-size: 12px; padding: 3px 12px; cursor: pointer;
  border: 1.5px solid var(--ink); border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.6);
}
.tabs button.on { background: var(--accent); color: #fff; }
.qr { display: grid; place-items: center; min-height: 200px; }
.qr-ph {
  width: 200px; height: 200px; display: grid; place-items: center;
  border: 1.5px dashed var(--ink); border-radius: var(--radius-md);
  font-size: 12px; opacity: 0.4;
}
hr { border: none; border-top: 1.5px dashed rgba(43, 43, 58, 0.2); margin: 2px 0; }
.actions { display: flex; gap: 8px; }
.btn-cartoon.sm { font-size: 11px; padding: 1px 8px; margin-left: 8px; }
</style>
