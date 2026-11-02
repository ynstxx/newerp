<script setup>
import { ref } from 'vue'
import { api } from '../api.js'
import { t } from '../i18n.js'

const emit = defineEmits(['logged-in'])
const email = ref('')
const password = ref('')
const busy = ref(false)
const error = ref('')

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await api.post('/api/auth/login', { email: email.value.trim(), password: password.value }, { tenant: false })
    emit('logged-in')
  } catch (err) {
    error.value = err.code === 'too_many_requests' ? err.details?.reason ?? t('login.failed') : t('login.failed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="wrap">
    <div class="brand">
      <div class="logo">N</div>
      <div class="brand-text">
        <div class="name">{{ t('app.name') }}</div>
        <div class="tagline erp-weak">{{ t('login.tagline') }}</div>
      </div>
    </div>

    <el-card class="card" shadow="never">
      <div class="card-head">
        <span class="title">{{ t('login.title') }}</span>
        <span class="erp-weak">{{ t('login.hint') }}</span>
      </div>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item :label="t('login.email')">
          <el-input v-model="email" autocomplete="username" data-test="email" />
        </el-form-item>
        <el-form-item :label="t('login.password')">
          <el-input
            v-model="password"
            type="password"
            show-password
            autocomplete="current-password"
            data-test="password"
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <el-button
          type="primary"
          :loading="busy"
          class="submit"
          data-test="submit"
          @click="submit"
        >
          {{ t('login.submit') }}
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  background: radial-gradient(1000px 520px at 50% -10%, rgba(79, 124, 255, 0.16), transparent 70%), var(--erp-bg);
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}
.logo {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, var(--erp-primary), #7a58ff);
  box-shadow: 0 6px 24px rgba(79, 124, 255, 0.35);
}
.name {
  font-size: 18px;
  font-weight: 600;
  color: var(--erp-text);
}
.tagline {
  margin-top: 2px;
}
.card {
  width: 380px;
  max-width: calc(100vw - 32px);
  background: var(--erp-surface);
  border: 1px solid var(--erp-border);
  border-radius: var(--erp-radius-card);
}
.card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 14px;
}
.title {
  font-size: 15px;
  font-weight: 600;
  color: var(--erp-text);
}
.submit {
  width: 100%;
  margin-top: 12px;
}
</style>
