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
    <el-card class="card">
      <template #header>
        <strong>{{ t('app.name') }}</strong>
        <span class="sub">{{ t('login.title') }}</span>
      </template>
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item :label="t('login.email')">
          <el-input v-model="email" autocomplete="username" data-test="email" />
        </el-form-item>
        <el-form-item :label="t('login.password')">
          <el-input v-model="password" type="password" show-password autocomplete="current-password" data-test="password" @keyup.enter="submit" />
        </el-form-item>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <el-button type="primary" :loading="busy" style="width: 100%; margin-top: 12px" data-test="submit" @click="submit">
          {{ t('login.submit') }}
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.wrap {
  min-height: 100vh;
  display: grid;
  place-items: center;
}
.card {
  width: 360px;
}
.sub {
  margin-left: 8px;
  color: #909399;
  font-size: 13px;
}
</style>
