<script setup>
/**
 * 集成配置：钉钉 / 企业微信各一条。
 * secrets 只回 configured 布尔值 —— 编辑时留空表示不改，前端也从不显示明文。
 * 同步按钮返回本次 counts，原样展示；同步日志走 /logs。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, currentTenant, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDateTime } from '../format.js'

const PROVIDERS = ['dingtalk', 'wecom']

const items = ref([])
const loading = ref(false)
const error = ref('')

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const form = reactive({ provider: 'dingtalk', corpId: '', agentId: '', appkey: '', appsecret: '', corpsecret: '', enabled: true })

const syncing = ref('')
const syncResult = ref(null)
const syncError = ref('')
const toggling = ref('')

const logsOpen = ref(false)
const logsFor = ref(null)
const logs = ref([])
const logsLoading = ref(false)
const logsError = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canConfig = () => has('integration:config')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)
const providerLabel = (p) => {
  const key = `f4.integ.providers.${p}`
  const label = t(key)
  return label === key ? p : label
}
const countsText = (counts) =>
  tp('f4.integ.counts', {
    depts: counts?.depts ?? 0,
    users: counts?.users ?? 0,
    created: counts?.created ?? 0,
    updated: counts?.updated ?? 0,
    disabled: counts?.disabled ?? 0,
    failed: counts?.failed ?? 0,
  })

/**
 * api.js 只有 get/post/patch/del，而集成更新后端只注册了 PUT。
 * 不改 api.js（并行契约），这里按同一套前缀规则补一个最小的 PUT 请求。
 */
async function put(path, body) {
  const slug = currentTenant()
  const res = await fetch(slug ? `/t/${slug}${path}` : path, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? res.statusText)
    err.status = res.status
    err.code = data?.error?.code
    err.details = data?.error?.details
    throw err
  }
  return data
}
/** 已存在的 provider 不能再建一条（后端也会 409，这里只是先把选项置灰） */
const takenProviders = computed(() => new Set(items.value.map((row) => row.provider)))
const creatableProviders = computed(() => PROVIDERS.filter((p) => !takenProviders.value.has(p)))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.get('/api/integrations')
    items.value = data.items ?? []
  } catch (err) {
    error.value = msgOf(err)
    items.value = []
    ElMessage.error(error.value)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  const next = creatableProviders.value[0] ?? 'dingtalk'
  editing.value = null
  Object.assign(form, { provider: next, corpId: '', agentId: '', appkey: '', appsecret: '', corpsecret: '', enabled: true })
  drawer.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    provider: row.provider,
    corpId: row.corpId ?? '',
    agentId: row.agentId ?? '',
    appkey: '',
    appsecret: '',
    corpsecret: '',
    enabled: Boolean(row.enabled),
  })
  drawer.value = true
}

/** 只提交填了的密钥：空字符串表示"不改"，不能被当成清空 */
function secretsOf() {
  /** @type {Record<string, string>} */
  const out = {}
  if (form.provider === 'dingtalk') {
    if (form.appkey.trim()) out.appkey = form.appkey.trim()
    if (form.appsecret.trim()) out.appsecret = form.appsecret.trim()
  } else if (form.corpsecret.trim()) {
    out.corpsecret = form.corpsecret.trim()
  }
  return out
}

async function save() {
  busy.value = true
  try {
    if (editing.value) {
      const secrets = secretsOf()
      await put(`/api/integrations/${editing.value.id}`, {
        corpId: form.corpId || null,
        agentId: form.agentId || null,
        enabled: form.enabled,
        ...(Object.keys(secrets).length ? { secrets } : {}),
      })
    } else {
      const secrets = secretsOf()
      await api.post('/api/integrations', {
        provider: form.provider,
        corpId: form.corpId || null,
        agentId: form.agentId || null,
        ...(Object.keys(secrets).length ? { secrets } : {}),
        enabled: form.enabled,
      })
    }
    ElMessage.success(t('action.saved'))
    drawer.value = false
    await load()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    busy.value = false
  }
}

async function toggleEnabled(row) {
  toggling.value = row.id
  try {
    await put(`/api/integrations/${row.id}`, { enabled: !row.enabled })
    await load()
  } catch (err) {
    ElMessage.error(msgOf(err))
    await load()
  } finally {
    toggling.value = ''
  }
}

async function sync(row) {
  syncing.value = row.id
  syncResult.value = null
  syncError.value = ''
  try {
    const data = await api.post(`/api/integrations/${row.id}/sync`)
    syncResult.value = data
    ElMessage.success(countsText(data.counts))
    await load()
  } catch (err) {
    // 未启用 / 缺密钥 / 外部接口失败：reason 留在页面上，不只一闪而过的 toast
    syncError.value = msgOf(err)
    ElMessage.error(syncError.value)
  } finally {
    syncing.value = ''
  }
}

async function openLogs(row) {
  logsFor.value = row
  logs.value = []
  logsError.value = ''
  logsOpen.value = true
  logsLoading.value = true
  try {
    const data = await api.get(`/api/integrations/${row.id}/logs?limit=20`)
    logs.value = data.items ?? []
  } catch (err) {
    logsError.value = msgOf(err)
    ElMessage.error(logsError.value)
  } finally {
    logsLoading.value = false
  }
}

onMounted(load)
</script>

<template>
  <PageTemplate>
    <template #search>
      <span class="erp-weak">{{ t('f4.integ.addHint') }}</span>
    </template>

    <template #actions>
      <el-button :loading="loading" @click="load">{{ t('top.refresh') }}</el-button>
      <el-button
        v-if="canConfig() && creatableProviders.length"
        type="primary"
        data-test="new"
        @click="openCreate"
      >
        {{ t('f4.integ.new') }}
      </el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />
    <el-alert
      v-if="syncResult"
      class="err"
      type="success"
      show-icon
      :title="tp('f4.integ.countsTitle', { provider: providerLabel(syncResult.provider) })"
      :description="`${t('f4.integ.syncResult')}: ${countsText(syncResult.counts)}`"
      @close="syncResult = null"
    />
    <el-alert
      v-if="syncError"
      class="err"
      type="warning"
      show-icon
      :title="t('f4.integ.sync')"
      :description="syncError"
      @close="syncError = null"
    />

    <el-table :data="items" v-loading="loading" border data-test="table">
      <el-table-column :label="t('f4.integ.provider')" width="120">
        <template #default="{ row }">
          <span>{{ providerLabel(row.provider) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.integ.corpId')" min-width="160">
        <template #default="{ row }">
          <span class="erp-ellipsis mono" :title="row.corpId">{{ row.corpId || t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.integ.agentId')" min-width="140">
        <template #default="{ row }">
          <span class="erp-ellipsis mono" :title="row.agentId">{{ row.agentId || t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.integ.secrets')" width="120">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" :type="row.secrets?.configured ? 'success' : 'info'">
            {{ row.secrets?.configured ? t('f4.integ.configured') : t('f4.integ.notConfigured') }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.integ.enabled')" width="100">
        <template #default="{ row }">
          <el-switch
            :model-value="row.enabled"
            :loading="toggling === row.id"
            :disabled="!canConfig() || toggling === row.id"
            @change="toggleEnabled(row)"
          />
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.integ.lastSync')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDateTime(row.lastSyncAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="230" align="right">
        <template #default="{ row }">
          <el-button v-if="canConfig()" link type="primary" @click="openEdit(row)">{{ t('action.edit') }}</el-button>
          <el-button
            v-if="canConfig()"
            link
            type="primary"
            :loading="syncing === row.id"
            @click="sync(row)"
          >
            {{ t('f4.integ.sync') }}
          </el-button>
          <el-button link type="primary" @click="openLogs(row)">{{ t('f4.integ.logs') }}</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('f4.integ.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f4.integ.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
    </template>
  </PageTemplate>

  <el-drawer
    v-model="drawer"
    :title="editing ? t('f4.integ.edit') : t('f4.integ.new')"
    size="460px"
    data-test="integ-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f4.integ.provider')" required>
        <el-select v-if="!editing" v-model="form.provider" style="width: 100%">
          <el-option v-for="p in creatableProviders" :key="p" :value="p" :label="providerLabel(p)" />
        </el-select>
        <span v-else>{{ providerLabel(editing.provider) }}</span>
      </el-form-item>
      <el-form-item :label="t('f4.integ.corpId')">
        <el-input v-model="form.corpId" maxlength="64" />
      </el-form-item>
      <el-form-item :label="t('f4.integ.agentId')">
        <el-input v-model="form.agentId" maxlength="64" />
      </el-form-item>

      <el-form-item v-if="form.provider === 'dingtalk'" :label="t('f4.integ.appkey')">
        <el-input v-model="form.appkey" maxlength="200" :placeholder="t('f4.integ.secretHint')" autocomplete="off" />
      </el-form-item>
      <el-form-item v-if="form.provider === 'dingtalk'" :label="t('f4.integ.appsecret')">
        <el-input v-model="form.appsecret" type="password" show-password maxlength="200" :placeholder="t('f4.integ.secretHint')" autocomplete="off" />
      </el-form-item>
      <el-form-item v-if="form.provider === 'wecom'" :label="t('f4.integ.corpsecret')">
        <el-input v-model="form.corpsecret" type="password" show-password maxlength="200" :placeholder="t('f4.integ.secretHint')" autocomplete="off" />
      </el-form-item>
      <div class="secret-note erp-weak">
        <el-tag v-if="editing" size="small" round effect="plain" :type="editing.secrets?.configured ? 'success' : 'info'">
          {{ editing.secrets?.configured ? t('f4.integ.configured') : t('f4.integ.notConfigured') }}
        </el-tag>
        <span>{{ t('f4.integ.secretHint') }}</span>
      </div>

      <el-form-item :label="t('f4.integ.enabled')">
        <el-switch v-model="form.enabled" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer
    v-model="logsOpen"
    :title="t('f4.integ.logs')"
    size="520px"
    data-test="integ-logs"
  >
    <div v-loading="logsLoading" class="logs">
      <div v-if="logsFor" class="logs-head">
        <span>{{ providerLabel(logsFor.provider) }}</span>
        <span class="erp-weak mono">{{ logsFor.corpId || '' }}</span>
      </div>
      <el-alert v-if="logsError" type="error" :title="logsError" :closable="false" show-icon />
      <el-table v-if="logs.length" :data="logs" border size="small">
        <el-table-column :label="t('f4.integ.at')" width="120">
          <template #default="{ row }">
            <span class="erp-weak">{{ fmtDateTime(row.at) }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('f4.integ.action')" width="90">
          <template #default="{ row }">
            <span class="erp-ellipsis" :title="row.action">{{ row.action }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('f4.integ.syncResult')" min-width="180">
          <template #default="{ row }">
            <span class="erp-ellipsis mono" :title="JSON.stringify(row.counts)">{{ countsText(row.counts) }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('f4.integ.error')" min-width="140">
          <template #default="{ row }">
            <span v-if="row.error" class="erp-ellipsis err-text" :title="row.error">{{ row.error }}</span>
            <span v-else class="erp-weak">{{ t('common.none') }}</span>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else-if="!logsError && !logsLoading" :image-size="56" :description="t('f4.integ.logsEmpty')" />
    </div>
  </el-drawer>
</template>

<style scoped>
.err {
  margin-bottom: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.secret-note {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.logs {
  min-height: 100px;
}
.logs-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-bottom: 12px;
}
.err-text {
  color: var(--erp-danger);
  font-size: 12px;
}
@media (max-width: 900px) {
  .secret-note {
    align-items: flex-start;
  }
}
</style>
