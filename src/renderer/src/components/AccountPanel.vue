<script setup lang="ts">
import { ref } from 'vue'
import type { PlatformAccountSnapshot } from '../../../shared/types'
import { useUiStore } from '../stores/ui'

const ui = useUiStore()
const open = ref(false)
const busyPlatform = ref('')
const expanded = ref<string>('')
const cookieText = ref('')
const cookieFor = ref('')
const notice = ref('')
const snapshots = ref<Record<string, PlatformAccountSnapshot>>({})

const PLATFORMS = [
  { key: 'douyin', label: '抖音', hint: 'douyin.com 的 Cookie（含 sessionid）' },
  { key: 'douyu', label: '斗鱼', hint: 'douyu.com 的 Cookie（含 acf_uid / yyuid）' },
  { key: 'huya', label: '虎牙', hint: 'huya.com 的 Cookie（含 yyuid / udb_passdata）' },
  { key: 'kuaishou', label: '快手', hint: 'kuaishou.com 的 Cookie（含 passToken）' }
] as const

function snapOf(key: string): PlatformAccountSnapshot | undefined {
  return snapshots.value[key]
}

async function refresh(key: string): Promise<void> {
  snapshots.value = {
    ...snapshots.value,
    [key]: (await window.lda.getPlatformAccounts(key)) as PlatformAccountSnapshot
  }
}

async function refreshAll(): Promise<void> {
  await Promise.all(PLATFORMS.map((p) => refresh(p.key)))
}

function labelOf(key: string): string {
  const s = snapOf(key)
  const p = PLATFORMS.find((x) => x.key === key)!
  if (!s) return `${p.label}：--`
  return `${p.label}：${s.isLogin ? `已登录（${s.uname ?? '已登录'}）` : '未登录'}`
}

async function openWindow(key: string): Promise<void> {
  busyPlatform.value = key
  notice.value = '已打开登录窗口：用手机扫码或账号密码登录，成功后本应用自动保存账号'
  await window.lda.openPlatformLoginWindow(key)
  // 轮询状态（用户在窗口里操作，这里只负责刷新）
  const timer = setInterval(async () => {
    await refresh(key)
    if (busyPlatform.value !== key) clearInterval(timer)
  }, 3000)
  setTimeout(() => {
    clearInterval(timer)
    busyPlatform.value = ''
    notice.value = ''
  }, 180_000)
}

async function submitCookie(key: string): Promise<void> {
  busyPlatform.value = key
  try {
    const res = (await window.lda.platformCookieLogin(key, cookieText.value)) as {
      ok?: boolean
      error?: string
    }
    if (res && res.ok === false) {
      notice.value = `${key} Cookie 导入失败：${res.error}`
    } else {
      notice.value = `${key} 账号已保存`
      cookieText.value = ''
      cookieFor.value = ''
      await refresh(key)
    }
  } finally {
    busyPlatform.value = ''
  }
}

async function doSwitch(key: string, id: string): Promise<void> {
  await window.lda.platformSwitchAccount(key, id)
  await refresh(key)
}

async function doRemove(key: string, id: string): Promise<void> {
  await window.lda.platformRemoveAccount(key, id)
  await refresh(key)
}

async function doLogout(key: string): Promise<void> {
  await window.lda.platformLogout(key)
  await refresh(key)
}

async function show(): Promise<void> {
  open.value = true
  await refreshAll()
}
</script>

<template>
  <button class="btn-cartoon" @click="show">🔑 平台账号</button>
  <Teleport to="body">
    <div v-if="open" class="mask" @click.self="open = false">
      <div class="dialog glass-card">
        <h3>🔑 平台账号</h3>
        <p class="hint">
          每个平台可保存多个账号并随时切换；「扫码登录」会打开平台官方登录页，
          用手机扫码（或账号密码）登录后本应用自动保存 Cookie。
        </p>
        <p v-if="notice" class="warn">{{ notice }}</p>

        <div v-for="p in PLATFORMS" :key="p.key" class="platform glass-card">
          <div class="platform__head">
            <b>{{ labelOf(p.key) }}</b>
            <span class="platform__actions">
              <button class="btn-cartoon sm" :disabled="busyPlatform === p.key" @click="openWindow(p.key)">
                扫码登录
              </button>
              <button class="btn-cartoon sm" @click="cookieFor = cookieFor === p.key ? '' : p.key">
                Cookie 导入
              </button>
              <button
                v-if="snapOf(p.key)?.isLogin"
                class="btn-cartoon sm"
                @click="doLogout(p.key)"
              >
                退出
              </button>
            </span>
          </div>

          <template v-if="cookieFor === p.key">
            <label>
              粘贴 {{ p.label }} 登录后的 Cookie
              <textarea v-model="cookieText" class="input-cartoon" rows="3" :placeholder="p.hint" />
            </label>
            <p class="hint">{{ p.hint }}（浏览器 F12 → Application → Cookies 复制）</p>
            <button
              class="btn-cartoon sm"
              :disabled="busyPlatform === p.key || !cookieText.trim()"
              @click="submitCookie(p.key)"
            >
              校验并保存
            </button>
          </template>

          <div v-if="snapOf(p.key)?.accounts?.length" class="accounts">
            <div
              v-for="a in snapOf(p.key)!.accounts"
              :key="a.id"
              class="account"
              :class="{ active: snapOf(p.key)!.activeId === a.id }"
            >
              <span>{{ a.uname }} <em>{{ new Date(a.savedAt).toLocaleString() }}</em></span>
              <span class="account__actions">
                <button
                  v-if="snapOf(p.key)!.activeId !== a.id"
                  class="btn-cartoon sm"
                  @click="doSwitch(p.key, a.id)"
                >
                  切换到此账号
                </button>
                <button v-else class="btn-cartoon sm" disabled>当前账号</button>
                <button class="btn-cartoon sm danger" @click="doRemove(p.key, a.id)">删除</button>
              </span>
            </div>
          </div>
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
  width: 500px; max-height: 86vh; overflow-y: auto; padding: 20px;
  display: flex; flex-direction: column; gap: 10px;
}
h3 { font-size: 15px; }
.platform { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.platform__head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; }
.platform__actions { display: flex; gap: 6px; }
.accounts { display: flex; flex-direction: column; gap: 6px; }
.account {
  display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;
  font-size: 12.5px; padding: 6px 8px;
  border: 1.5px dashed rgba(43, 43, 58, 0.25); border-radius: var(--radius-sm);
}
.account.active { border-style: solid; border-color: var(--accent); background: rgba(255, 153, 0, 0.08); }
.account em { font-style: normal; opacity: 0.55; font-size: 11px; margin-left: 6px; }
.account__actions { display: flex; gap: 6px; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
p { font-size: 12.5px; line-height: 1.6; }
.hint { opacity: 0.65; }
.warn { color: #a35a00; }
.actions { display: flex; gap: 8px; }
.btn-cartoon.sm { font-size: 11px; padding: 1px 8px; }
.btn-cartoon.danger { color: #c0392b; }
</style>
