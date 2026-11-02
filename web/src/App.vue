<script setup>
import { onMounted, ref } from 'vue'
import { api } from './api.js'
import { i18n, setLang, t } from './i18n.js'
import { logout as clearState, pickTenant, rememberedTenant, state } from './state.js'
import LoginView from './views/LoginView.vue'
import PartyListView from './views/PartyListView.vue'

const booted = ref(false)

async function pickAndLoad(slug) {
  pickTenant(slug)
  // 租户作用域的 /api/me 才有 perms，界面据此决定显不显示删按钮
  const me = await api.get('/api/me')
  state.perms = me.perms ?? []
  if (me.tenant) state.tenant = { ...me.tenant }
}

async function loadMe() {
  const me = await api.get('/api/me', { tenant: false })
  state.user = me.user
  state.tenants = me.tenants ?? []
  const remembered = rememberedTenant()
  const target = state.tenants.find((x) => x.slug === remembered) ?? state.tenants[0]
  if (target) await pickAndLoad(target.slug)
}

onMounted(async () => {
  setLang(i18n.lang === 'zh' ? 'zh' : 'en')
  try {
    await loadMe()
  } catch {
    // 401 = 还没登录，正常路径
  } finally {
    booted.value = true
  }
})

async function onLoggedIn() {
  await loadMe()
}

async function signOut() {
  try {
    await api.post('/api/auth/logout', {}, { tenant: false })
  } finally {
    clearState()
  }
}
</script>

<template>
  <div v-if="!booted" class="boot">…</div>

  <LoginView v-else-if="!state.user" @logged-in="onLoggedIn" />

  <div v-else class="shell">
    <header class="bar">
      <strong>{{ t('app.name') }}</strong>

      <template v-if="state.tenant">
        <el-divider direction="vertical" />
        <span class="company">{{ state.tenant.name }}</span>
        <el-dropdown v-if="state.tenants.length > 1" trigger="click">
          <el-button link type="primary">{{ t('company.switch') }}</el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="item in state.tenants"
                :key="item.slug"
                @click="pickAndLoad(item.slug)"
              >
                {{ item.name }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </template>

      <div class="spacer" />
      <span class="who">{{ t('nav.hello') }}，{{ state.user.displayName }}</span>
      <el-button link @click="setLang(i18n.lang === 'zh' ? 'en' : 'zh')">{{ t('app.lang') }}</el-button>
      <el-button link type="danger" @click="signOut">{{ t('nav.logout') }}</el-button>
    </header>

    <main class="body">
      <PartyListView v-if="state.tenant" />
      <el-empty v-else :description="t('company.empty')" />
    </main>
  </div>
</template>

<style>
:root {
  --erp-gap: 12px;
}
body {
  margin: 0;
  font-family: system-ui, -apple-system, 'Segoe UI', 'Noto Sans SC', sans-serif;
  background: #f5f7fa;
}
.boot {
  padding: 40px;
  text-align: center;
  color: #909399;
}
.shell {
  min-height: 100vh;
}
.bar {
  display: flex;
  align-items: center;
  gap: var(--erp-gap);
  padding: 10px 20px;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
}
.bar .company {
  color: #606266;
}
.bar .spacer {
  flex: 1;
}
.bar .who {
  color: #909399;
  font-size: 13px;
}
.body {
  padding: 16px 20px;
}
</style>
