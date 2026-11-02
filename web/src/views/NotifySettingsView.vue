<script setup>
/**
 * 通知设置：渠道 + 模板两个 Tab，底部「发测试消息」。
 *
 * - 渠道密钥后端只回 `config.configured:true`；PUT 是**合并**语义，
 *   所以编辑时密钥框留空 = 不修改（页面上明确写出来），非密钥字段置空 = 删掉该键。
 * - 渠道 / 模板更新是 PUT，走 api.js 的 api.put（主线已补）。
 * - 模板同一 code + channel 可分别维护 zh / en 两条，列表里用语言标签区分。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDateTime } from '../format.js'

const CHANNEL_TYPES = ['inapp', 'email', 'dingtalk', 'wecom']
const LANGS = ['zh', 'en']

/** 每种渠道的配置字段；secret=true 的字段后端只回 configured，不回值 */
const CHANNEL_FIELDS = {
  inapp: [],
  email: [
    { key: 'base_url', label: 'baseUrl', placeholder: 'https://api.resend.com' },
    { key: 'path', label: 'path', placeholder: '/emails' },
    { key: 'from', label: 'from', placeholder: 'ERP <no-reply@example.com>' },
    { key: 'api_key', label: 'apiKey', secret: true },
    { key: 'timeout_ms', label: 'timeoutMs', placeholder: '15000' },
  ],
  dingtalk: [
    { key: 'webhook', label: 'webhook', secret: true, placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=…' },
    { key: 'secret', label: 'secret', secret: true },
  ],
  wecom: [
    { key: 'webhook', label: 'webhook', secret: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…' },
  ],
}

const tab = ref('channels')
const keyword = ref('')
const langFilter = ref('')

const channels = ref([])
const channelsLoading = ref(false)
const channelsError = ref('')

const templates = ref([])
const templatesLoading = ref(false)
const templatesError = ref('')

const chOpen = ref(false)
const chEditing = ref(null)
const chBusy = ref(false)
const chForm = reactive({ type: 'email', enabled: true, config: {} })

const tplOpen = ref(false)
const tplEditing = ref(null)
const tplBusy = ref(false)
const tplForm = reactive({ code: '', channel: 'inapp', lang: 'zh', subject: '', body: '' })

const testOpen = ref(false)
const testChannel = ref('inapp')
const testBusy = ref(false)
const testResult = ref(null)

const has = (perm) => {
  const perms = state.perms
  if (perms.includes('*') || perms.includes(perm)) return true
  const [mod, action] = perm.split(':')
  return perms.includes(`${mod}:*`) || perms.includes(`*:${action}`)
}
const canConfig = computed(() => has('notify:config'))
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

const chLabel = (type) => t(`f1.notify.chType.${type}`)
const langLabel = (lang) => t(`f1.notify.langName.${lang}`)

const kw = computed(() => keyword.value.trim().toLowerCase())
const channelsShown = computed(() => {
  const k = kw.value
  if (!k) return channels.value
  return channels.value.filter((row) =>
    [chLabel(row.type), row.type, configText(row)].some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})
const templatesShown = computed(() => {
  const k = kw.value
  return templates.value.filter((row) => {
    if (langFilter.value && row.lang !== langFilter.value) return false
    if (!k) return true
    return [row.code, row.channel, row.subject, row.body, langLabel(row.lang)]
      .some((v) => String(v ?? '').toLowerCase().includes(k))
  })
})

function configText(row) {
  const cfg = row.config ?? {}
  const parts = Object.entries(cfg)
    .filter(([k, v]) => k !== 'configured' && v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}=${String(v)}`)
  return parts.join(' · ') || t('common.none')
}

async function loadChannels() {
  if (!canConfig.value) {
    channelsError.value = t('f1.notify.noPermission')
    return
  }
  channelsLoading.value = true
  channelsError.value = ''
  try {
    const data = await api.get('/api/notify/channels')
    channels.value = data.items ?? []
  } catch (err) {
    channelsError.value = msgOf(err)
    channels.value = []
    ElMessage.error(channelsError.value)
  } finally {
    channelsLoading.value = false
  }
}

async function loadTemplates() {
  if (!canConfig.value) {
    templatesError.value = t('f1.notify.noPermission')
    return
  }
  templatesLoading.value = true
  templatesError.value = ''
  try {
    const data = await api.get('/api/notify/templates')
    templates.value = data.items ?? []
  } catch (err) {
    templatesError.value = msgOf(err)
    templates.value = []
    ElMessage.error(templatesError.value)
  } finally {
    templatesLoading.value = false
  }
}

function refresh() {
  loadChannels()
  loadTemplates()
}

// —— 渠道 ——

function openChannelCreate() {
  chEditing.value = null
  Object.assign(chForm, { type: 'email', enabled: true })
  fillConfig({})
  chOpen.value = true
}

/** 按当前 type 重建配置表单；公开配置里没有密钥，密钥框一律从空开始 */
function fillConfig(source) {
  chForm.config = {}
  for (const f of CHANNEL_FIELDS[chForm.type] ?? []) {
    const v = source[f.key]
    chForm.config[f.key] = v === undefined || v === null ? '' : String(v)
  }
}

function onChannelTypeChange() {
  fillConfig({})
}

function openChannelEdit(row) {
  chEditing.value = row
  Object.assign(chForm, { type: row.type, enabled: Boolean(row.enabled) })
  fillConfig(row.config ?? {})
  chOpen.value = true
}

const chFields = computed(() => CHANNEL_FIELDS[chForm.type] ?? [])

function configPayload() {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const f of chFields.value) {
    const raw = String(chForm.config[f.key] ?? '').trim()
    if (f.secret) {
      // 留空 = 不修改（后端是合并语义）
      if (raw) out[f.key] = raw
    } else {
      // 非密钥置空 = 删除该键
      out[f.key] = raw === '' ? null : raw
    }
  }
  return out
}

async function saveChannel() {
  chBusy.value = true
  try {
    if (chEditing.value) {
      await api.put(`/api/notify/channels/${chEditing.value.id}`, {
        enabled: chForm.enabled,
        config: configPayload(),
        version: chEditing.value.version,
      })
    } else {
      await api.post('/api/notify/channels', {
        type: chForm.type,
        enabled: chForm.enabled,
        config: configPayload(),
      })
    }
    ElMessage.success(t('action.saved'))
    chOpen.value = false
    loadChannels()
  } catch (err) {
    // 409 版本冲突 / 400 字段错误都摊开
    ElMessage.error(msgOf(err))
  } finally {
    chBusy.value = false
  }
}

async function toggleChannel(row, enabled) {
  try {
    const updated = await api.put(`/api/notify/channels/${row.id}`, { enabled, version: row.version })
    Object.assign(row, updated)
    ElMessage.success(t('action.saved'))
  } catch (err) {
    ElMessage.error(msgOf(err))
    loadChannels()
  }
}

// —— 模板 ——

function openTemplateCreate() {
  tplEditing.value = null
  Object.assign(tplForm, { code: '', channel: 'inapp', lang: 'zh', subject: '', body: '' })
  tplOpen.value = true
}

function openTemplateEdit(row) {
  tplEditing.value = row
  Object.assign(tplForm, {
    code: row.code ?? '',
    channel: row.channel ?? 'inapp',
    lang: row.lang ?? 'zh',
    subject: row.subject ?? '',
    body: row.body ?? '',
  })
  tplOpen.value = true
}

async function saveTemplate() {
  if (!tplForm.code.trim() || !tplForm.body.trim()) {
    ElMessage.warning(t('common.required'))
    return
  }
  tplBusy.value = true
  try {
    if (tplEditing.value) {
      await api.put(`/api/notify/templates/${tplEditing.value.id}`, {
        lang: tplForm.lang,
        subject: tplForm.subject || '',
        body: tplForm.body,
        version: tplEditing.value.version,
      })
    } else {
      await api.post('/api/notify/templates', {
        code: tplForm.code.trim(),
        channel: tplForm.channel,
        lang: tplForm.lang,
        subject: tplForm.subject || undefined,
        body: tplForm.body,
      })
    }
    ElMessage.success(t('action.saved'))
    tplOpen.value = false
    loadTemplates()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    tplBusy.value = false
  }
}

// —— 测试消息 ——

function openTest() {
  testResult.value = null
  testOpen.value = true
}

async function sendTest() {
  testBusy.value = true
  testResult.value = null
  try {
    // 后端返回 {ok, channel, error?}：ok=false 也是 200，必须把 error 显示出来
    testResult.value = await api.post('/api/notify/test', { channel: testChannel.value })
  } catch (err) {
    testResult.value = { ok: false, channel: testChannel.value, error: msgOf(err) }
  } finally {
    testBusy.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input v-model="keyword" :placeholder="t('f1.notify.search')" clearable class="search" data-test="search">
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-select v-if="tab === 'templates'" v-model="langFilter" clearable :placeholder="t('f1.notify.lang')" class="pick">
        <el-option v-for="l in LANGS" :key="l" :value="l" :label="langLabel(l)" />
      </el-select>
    </template>

    <template #actions>
      <template v-if="canConfig">
        <el-button v-if="tab === 'channels'" type="primary" data-test="ch-new" @click="openChannelCreate">
          {{ t('f1.notify.newChannel') }}
        </el-button>
        <el-button v-else type="primary" data-test="tpl-new" @click="openTemplateCreate">
          {{ t('f1.notify.newTemplate') }}
        </el-button>
      </template>
      <span v-else class="erp-weak">{{ t('f1.notify.noPermission') }}</span>
    </template>

    <el-tabs v-model="tab" class="tabs" data-test="nt-tabs">
      <el-tab-pane :label="t('f1.notify.tabChannels')" name="channels">
        <el-alert v-if="channelsError" class="err" type="error" :title="channelsError" :closable="false" show-icon />
        <el-table :data="channelsShown" v-loading="channelsLoading" border data-test="table-channels">
          <el-table-column :label="t('f1.notify.type')" width="140">
            <template #default="{ row }">
              <span class="ch-type erp-ellipsis" :title="row.type">{{ chLabel(row.type) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.notify.enabled')" width="100">
            <template #default="{ row }">
              <el-switch
                :model-value="row.enabled"
                size="small"
                :disabled="!canConfig"
                @change="(v) => toggleChannel(row, v)"
              />
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.notify.config')" min-width="260">
            <template #default="{ row }">
              <span class="erp-ellipsis mono" :title="configText(row)">{{ configText(row) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.notify.secret')" width="110">
            <template #default="{ row }">
              <el-tag size="small" round effect="plain" :type="row.config?.configured ? 'success' : 'info'">
                {{ row.config?.configured ? t('f1.common.configured') : t('f1.common.notConfigured') }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.notify.updatedAt')" width="130">
            <template #default="{ row }">
              <span class="erp-weak">{{ fmtDateTime(row.updatedAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="''" width="80" align="right">
            <template #default="{ row }">
              <el-button v-if="canConfig" link type="primary" @click="openChannelEdit(row)">{{ t('action.edit') }}</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :image-size="64" :description="kw ? t('common.noMatch') : t('f1.notify.emptyChannels')" />
          </template>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="t('f1.notify.tabTemplates')" name="templates">
        <el-alert v-if="templatesError" class="err" type="error" :title="templatesError" :closable="false" show-icon />
        <el-table :data="templatesShown" v-loading="templatesLoading" border data-test="table-templates">
          <el-table-column prop="code" :label="t('f1.notify.code')" min-width="190">
            <template #default="{ row }">
              <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.notify.channel')" width="120">
            <template #default="{ row }">{{ chLabel(row.channel) }}</template>
          </el-table-column>
          <el-table-column :label="t('f1.notify.lang')" width="90">
            <template #default="{ row }">
              <el-tag size="small" round effect="plain" :type="row.lang === 'en' ? 'warning' : 'primary'">
                {{ langLabel(row.lang) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.notify.subject')" min-width="220">
            <template #default="{ row }">
              <span class="erp-ellipsis" :title="row.subject">{{ row.subject || t('common.none') }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.notify.updatedAt')" width="130">
            <template #default="{ row }">
              <span class="erp-weak">{{ fmtDateTime(row.updatedAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="''" width="80" align="right">
            <template #default="{ row }">
              <el-button v-if="canConfig" link type="primary" @click="openTemplateEdit(row)">{{ t('action.edit') }}</el-button>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :image-size="64" :description="kw || langFilter ? t('common.noMatch') : t('f1.notify.emptyTemplates')" />
          </template>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <template #hint>
      {{ tab === 'channels' ? t('f1.notify.hintChannels') : t('f1.notify.hintTemplates') }} ·
      {{ tp('page.loaded', { n: tab === 'channels' ? channels.length : templates.length }) }}
      <template v-if="kw"> · {{ t('common.clientFilter') }}</template>
    </template>

    <!-- 发测试消息放在底栏：它是「验证配置」的收尾动作，不是主操作 -->
    <template #pager>
      <el-button :loading="channelsLoading || templatesLoading" @click="refresh">{{ t('f1.common.refresh') }}</el-button>
      <el-button type="primary" plain data-test="nt-test" @click="openTest">{{ t('f1.notify.test') }}</el-button>
    </template>
  </PageTemplate>

  <el-drawer
    v-model="chOpen"
    :title="chEditing ? t('f1.notify.editChannel') : t('f1.notify.newChannel')"
    size="480px"
    data-test="ch-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f1.notify.type')" required>
        <el-select v-model="chForm.type" :disabled="!!chEditing" style="width: 100%" @change="onChannelTypeChange">
          <el-option v-for="k in CHANNEL_TYPES" :key="k" :value="k" :label="chLabel(k)" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f1.notify.enabled')">
        <el-switch v-model="chForm.enabled" />
      </el-form-item>
      <div v-if="chForm.type === 'inapp'" class="erp-weak inapp-note">{{ t('f1.notify.inappNote') }}</div>
      <template v-else>
        <el-form-item v-for="f in chFields" :key="f.key" :label="t(`f1.notify.${f.label}`)">
          <el-input
            v-model="chForm.config[f.key]"
            :type="f.secret ? 'password' : 'text'"
            :show-password="f.secret"
            :placeholder="f.secret ? t('f1.notify.leaveBlank') : f.placeholder"
            autocomplete="new-password"
            :data-test="`ch-${f.key}`"
          />
        </el-form-item>
        <div class="erp-weak hint">{{ t('f1.notify.secretHint') }}</div>
      </template>
    </el-form>
    <template #footer>
      <el-button @click="chOpen = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="chBusy" data-test="ch-save" @click="saveChannel">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer
    v-model="tplOpen"
    :title="tplEditing ? t('f1.notify.editTemplate') : t('f1.notify.newTemplate')"
    size="560px"
    data-test="tpl-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f1.notify.code')" :required="!tplEditing">
        <el-input
          v-model="tplForm.code"
          :disabled="!!tplEditing"
          maxlength="64"
          :placeholder="t('f1.notify.codeHint')"
          data-test="tpl-code"
        />
      </el-form-item>
      <el-form-item :label="t('f1.notify.channel')" required>
        <el-select v-model="tplForm.channel" :disabled="!!tplEditing" style="width: 100%">
          <el-option v-for="k in CHANNEL_TYPES" :key="k" :value="k" :label="chLabel(k)" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f1.notify.lang')">
        <el-radio-group v-model="tplForm.lang">
          <el-radio-button v-for="l in LANGS" :key="l" :value="l">{{ langLabel(l) }}</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="t('f1.notify.subject')">
        <el-input v-model="tplForm.subject" maxlength="500" />
      </el-form-item>
      <el-form-item :label="t('f1.notify.body')" required>
        <el-input v-model="tplForm.body" type="textarea" :rows="8" maxlength="20000" data-test="tpl-body" />
      </el-form-item>
      <div class="erp-weak hint">{{ t('f1.notify.bilingualHint') }}</div>
    </el-form>
    <template #footer>
      <el-button @click="tplOpen = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="tplBusy" data-test="tpl-save" @click="saveTemplate">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-dialog v-model="testOpen" :title="t('f1.notify.testTitle')" width="420px" data-test="nt-test-dialog">
    <el-form label-position="top">
      <el-form-item :label="t('f1.notify.channel')">
        <el-select v-model="testChannel" style="width: 100%">
          <el-option v-for="k in CHANNEL_TYPES" :key="k" :value="k" :label="chLabel(k)" />
        </el-select>
      </el-form-item>
    </el-form>
    <div class="erp-weak hint">{{ t('f1.notify.testHint') }}</div>
    <el-alert
      v-if="testResult"
      class="test-result"
      :type="testResult.ok ? 'success' : 'error'"
      :title="testResult.ok ? t('f1.notify.testOk') : t('f1.notify.testFail')"
      :closable="false"
      show-icon
    >
      <div v-if="testResult.error" class="mono test-err">{{ testResult.error }}</div>
    </el-alert>
    <template #footer>
      <el-button @click="testOpen = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="testBusy" data-test="nt-test-send" @click="sendTest">
        {{ t('f1.notify.send') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.search {
  width: 230px;
}
.pick {
  width: 130px;
}
.tabs {
  margin-top: -6px;
}
.err {
  margin-bottom: 12px;
}
.ch-type {
  font-weight: 600;
  color: var(--erp-text);
}
.code,
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.hint {
  line-height: 1.6;
  margin-top: -4px;
}
.inapp-note {
  padding: 12px;
  border: 1px solid var(--erp-border);
  border-radius: var(--erp-radius-sm);
  background: var(--erp-surface-2);
}
.test-result {
  margin-top: 12px;
}
.test-err {
  word-break: break-word;
  color: var(--erp-danger);
}
@media (max-width: 900px) {
  .search,
  .pick {
    width: 100%;
  }
}
</style>
