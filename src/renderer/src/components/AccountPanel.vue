<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PlatformAccountSnapshot } from '../../../shared/types'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
const open = ref(false)
const busy = ref(false)
const notice = ref('')
const snapshot = ref<PlatformAccountSnapshot | null>(null)
// 登录区
const tab = ref<'qr' | 'cookie'>('qr')
const qrImage = ref('')
const qrPhase = ref<string>('idle')
const qrMessage = ref('')
const cookieText = ref('')
let qrKey = ''
let qrTimer: ReturnType<typeof setInterval> | null = null

const PLATFORMS = [
  { key: 'bilibili', label: 'B站' },
  { key: 'douyin', label: '抖音' },
  { key: 'douyu', label: '斗鱼' },
  { key: 'huya', label: '虎牙' },
  { key: 'kuaishou', label: '快手' }
] as const

const platformLabel = computed(
  () => PLATFORMS.find((p) => p.key === ui.activePlatform)?.label ?? ui.activePlatform
)
/** 顶栏按钮：当前平台的账号概要 */
const buttonLabel = computed(() => {
  const s = snapshot.value
  const name = s?.uname || (s?.isLogin ? '已登录' : '')
  return `👤 ${platformLabel.value}：${name || '未登录'}`
})

function stopPolling(): void {
  if (qrTimer) {
    clearInterval(qrTimer)
    qrTimer = null
  }
}

async function refresh(): Promise<void> {
  snapshot.value = (await window.lda.getPlatformAccounts(ui.activePlatform)) as PlatformAccountSnapshot
}

/** 生成二维码：B 站应用内原生二维码；其它平台打开官方登录窗口（窗口里也有平台二维码） */
async function startQr(): Promise<void> {
  stopPolling()
  qrImage.value = ''
  qrPhase.value = 'waiting-scan'
  qrMessage.value = ''
  if (ui.activePlatform !== 'bilibili') {
    await openWindow()
    return
  }
  const res = (await window.lda.startQrLogin('bilibili')) as {
    ok?: boolean
    error?: string
    session?: { qrDataUrl: string; key: string; expiresAt: number }
  }
  if (!res || !res.ok || !res.session) {
    qrPhase.value = 'error'
    qrMessage.value = res?.error ?? '生成二维码失败'
    return
  }
  qrImage.value = res.session.qrDataUrl
  qrKey = res.session.key
  qrTimer = setInterval(pollQr, 2000)
}

async function pollQr(): Promise<void> {
  if (!qrKey) return
  const res = (await window.lda.pollQrLogin(qrKey, 'bilibili')) as {
    phase?: string
    message?: string
    state?: PlatformAccountSnapshot
  }
  qrPhase.value = res?.phase ?? 'error'
  qrMessage.value = res?.message ?? ''
  if (res?.phase === 'confirmed') {
    stopPolling()
    snapshot.value = res.state ?? null
    qrImage.value = ''
    notice.value = 'B 站登录成功，账号已保存'
  } else if (res?.phase === 'expired' || res?.phase === 'error') {
    stopPolling()
  }
}

async function openWindow(): Promise<void> {
  notice.value = '已打开官方登录窗口：用手机扫码或账号密码登录，成功后自动保存账号'
  await window.lda.openPlatformLoginWindow(ui.activePlatform)
}

async function submitCookie(): Promise<void> {
  busy.value = true
  notice.value = ''
  try {
    const res = (await window.lda.platformCookieLogin(ui.activePlatform, cookieText.value)) as {
      ok?: boolean
      error?: string
    }
    if (res && res.ok === false) {
      notice.value = `导入失败：${res.error}`
    } else {
      notice.value = 'Cookie 已校验并保存为账号'
      cookieText.value = ''
      await refresh()
    }
  } finally {
    busy.value = false
  }
}

async function doSwitch(id: string): Promise<void> {
  await window.lda.platformSwitchAccount(ui.activePlatform, id)
  await refresh()
}

async function doRemove(id: string): Promise<void> {
  await window.lda.platformRemoveAccount(ui.activePlatform, id)
  await refresh()
}

async function doLogout(): Promise<void> {
  await window.lda.platformLogout(ui.activePlatform)
  await refresh()
}

async function show(): Promise<void> {
  open.value = true
  tab.value = 'qr'
  notice.value = ''
  await refresh()
}

function switchPlatform(key: string): void {
  ui.setActivePlatform(key)
  stopPolling()
  qrImage.value = ''
  qrKey = ''
  qrPhase.value = 'idle'
  qrMessage.value = ''
  notice.value = ''
  cookieText.value = ''
  void refresh()
}

watch(open, (v) => {
  if (v) ui.openModal()
  else {
    ui.closeModal()
    stopPolling()
  }
})

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString()
}
</script>

<template>
  <button class="btn-cartoon" data-test="account-info" @click="show">{{ buttonLabel }}</button>
  <Teleport to="body">
    <div v-if="open" class="mask" @click.self="open = false">
      <div class="dialog glass-card">
        <h3>👤 账号信息</h3>

        <!-- 平台切换 -->
        <div class="ptabs">
          <button
            v-for="p in PLATFORMS"
            :key="p.key"
            :class="{ on: ui.activePlatform === p.key }"
            @click="switchPlatform(p.key)"
          >
            {{ p.label }}
          </button>
        </div>

        <!-- 账号信息 -->
        <div class="info glass-card">
          <template v-if="snapshot?.isLogin">
            <p class="ok">
              已登录：<b>{{ snapshot.uname || '已登录' }}</b>
              <button class="btn-cartoon sm" @click="doLogout">退出登录</button>
            </p>
            <p class="hint">当前会话即登录态：房间页可直接发送弹幕（游客态页面没有输入框）。</p>
          </template>
          <p v-else class="warn">
            {{ platformLabel }} 未登录 —— 抓取弹幕不需要登录；发送弹幕与部分平台的弹幕区展示需要登录。
          </p>

          <div v-if="snapshot?.accounts?.length" class="accounts">
            <div class="acc-title">已保存账号（{{ snapshot.accounts.length }}）</div>
            <div
              v-for="a in snapshot.accounts"
              :key="a.id"
              class="account"
              :class="{ active: snapshot.activeId === a.id }"
            >
              <span>{{ a.uname }} <em>{{ fmtTime(a.savedAt) }}</em></span>
              <span class="account__actions">
                <button
                  v-if="snapshot.activeId !== a.id"
                  class="btn-cartoon sm"
                  @click="doSwitch(a.id)"
                >
                  切换
                </button>
                <button v-else class="btn-cartoon sm" disabled>当前</button>
                <button class="btn-cartoon sm danger" @click="doRemove(a.id)">删除</button>
              </span>
            </div>
          </div>
        </div>

        <!-- 登录 / 添加账号 -->
        <div class="login-area">
          <div class="tabs">
            <button :class="{ on: tab === 'qr' }" @click="tab = 'qr'">扫码登录</button>
            <button :class="{ on: tab === 'cookie' }" @click="tab = 'cookie'">Cookie 登录</button>
          </div>

          <template v-if="tab === 'qr'">
            <div class="qr">
              <img v-if="qrImage" :src="qrImage" alt="登录二维码" width="200" height="200" />
              <div v-else class="qr-ph">
                {{ ui.activePlatform === 'bilibili' ? '二维码' : '官方窗口' }}
              </div>
            </div>
            <p class="hint">
              {{
                qrMessage ||
                (ui.activePlatform === 'bilibili'
                  ? qrPhase === 'idle'
                    ? '点击下方按钮生成二维码，用 B 站手机客户端扫码'
                    : ''
                  : '点击下方按钮打开官方登录窗口，在窗口内用手机扫码或账号密码登录')
              }}
            </p>
            <button class="btn-cartoon" :disabled="busy" @click="startQr">
              {{ ui.activePlatform === 'bilibili' ? (qrImage ? '重新生成二维码' : '生成二维码') : '打开登录窗口' }}
            </button>
          </template>

          <template v-else>
            <label>
              粘贴 {{ platformLabel }} 登录后的 Cookie
              <textarea v-model="cookieText" class="input-cartoon" rows="3" placeholder="name=value; ..." />
            </label>
            <p class="hint">浏览器登录平台官网 → F12 → Application → Cookies 复制（应用会校验关键登录 Cookie）</p>
            <button class="btn-cartoon" :disabled="busy || !cookieText.trim()" @click="submitCookie">
              校验并保存为账号
            </button>
          </template>
          <p v-if="notice" class="ok">{{ notice }}</p>
        </div>

        <div class="actions">
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
  width: 460px; max-height: 86vh; overflow-y: auto; padding: 20px;
  display: flex; flex-direction: column; gap: 10px;
}
h3 { font-size: 15px; }
.ptabs { display: flex; gap: 4px; flex-wrap: wrap; }
.ptabs button {
  font: inherit; font-size: 12px; padding: 3px 12px; cursor: pointer;
  border: 1.5px solid var(--ink); border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.6);
}
.ptabs button.on { background: var(--accent); color: #fff; }
.info { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.accounts { display: flex; flex-direction: column; gap: 6px; }
.acc-title { font-size: 12px; font-weight: 700; opacity: 0.7; }
.account {
  display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;
  font-size: 12.5px; padding: 6px 8px;
  border: 1.5px dashed rgba(43, 43, 58, 0.25); border-radius: var(--radius-sm);
}
.account.active { border-style: solid; border-color: var(--accent); background: rgba(255, 153, 0, 0.08); }
.account em { font-style: normal; opacity: 0.55; font-size: 11px; margin-left: 6px; }
.account__actions { display: flex; gap: 6px; }
.login-area { display: flex; flex-direction: column; gap: 8px; }
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
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
p { font-size: 12.5px; line-height: 1.6; }
.ok { color: #0a7d43; }
.warn { color: #a35a00; }
.hint { opacity: 0.65; }
.actions { display: flex; gap: 8px; }
.btn-cartoon.sm { font-size: 11px; padding: 1px 8px; }
.btn-cartoon.danger { color: #c0392b; }
</style>
