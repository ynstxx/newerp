<script setup>
/**
 * 变更签证：建单 → 提交审批 → 审批通过后后端把金额累加到项目合同额。
 * 列表带 status / errorMessage（落账失败时才有）；审批通过是 applied，不是 success，
 * 所以状态标签统一走 f2.costatus.*。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDate, fmtDateTime, money, shortId } from '../format.js'

const STATUSES = ['draft', 'pending', 'applied', 'rejected', 'failed', 'cancelled']

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const projectId = ref('')
const status = ref('')

const projects = ref([])
const projectMap = computed(() => new Map(projects.value.map((p) => [p.id, p])))
const projectCode = (id) => projectMap.value.get(id)?.code ?? (id ? shortId(id) : t('common.none'))

/** 后端 list 不接 q：搜索过滤已加载的行 */
const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return items.value
  return items.value.filter((row) =>
    [row.code, row.title, row.reason, projectCode(row.projectId)]
      .some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const submitting = ref('')
const form = reactive({ projectId: '', code: '', title: '', amount: '', reason: '' })

const detailOpen = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
/** 详情接口失败：抽屉里给原因，不假装“没有数据” */
const detailError = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('work:create')
const canUpdate = () => has('work:update')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

const statusTagType = (s) =>
  s === 'applied' ? 'success' : s === 'failed' || s === 'rejected' ? 'danger' : s === 'pending' ? 'warning' : 'info'

async function loadProjects() {
  try {
    const data = await api.get('/api/projects?limit=100')
    projects.value = data.items ?? []
  } catch {
    // 项目编码退化显示 id 前缀
  }
}

async function load(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    if (projectId.value) qs.set('projectId', projectId.value)
    if (status.value) qs.set('status', status.value)
    const data = await api.get(`/api/change-orders?${qs}`)
    items.value = reset ? data.items : [...items.value, ...data.items]
    cursor.value = data.nextCursor ?? ''
  } catch (err) {
    error.value = msgOf(err)
    if (reset) items.value = []
    ElMessage.error(error.value)
  } finally {
    loading.value = false
  }
}

function refresh() {
  cursor.value = ''
  load(true)
}

function openNew() {
  editing.value = null
  Object.assign(form, { projectId: projectId.value || '', code: '', title: '', amount: '', reason: '' })
  drawer.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    projectId: row.projectId ?? '',
    code: row.code ?? '',
    title: row.title ?? '',
    amount: row.amount == null ? '' : String(row.amount),
    reason: row.reason ?? '',
  })
  drawer.value = true
}

async function save() {
  if (form.amount === '' || Number(form.amount) === 0) {
    ElMessage.warning(t('f2.changes.amountHint'))
    return
  }
  if (!editing.value && (!form.projectId || !form.code.trim() || !form.title.trim())) {
    ElMessage.warning(t('common.required'))
    return
  }
  if (editing.value && !form.title.trim()) {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    if (editing.value) {
      await api.patch(`/api/change-orders/${editing.value.id}`, {
        title: form.title.trim(),
        amount: Number(form.amount),
        reason: form.reason || null,
        version: editing.value.version,
      })
    } else {
      await api.post('/api/change-orders', {
        projectId: form.projectId,
        code: form.code.trim(),
        title: form.title.trim(),
        amount: Number(form.amount),
        reason: form.reason || null,
      })
    }
    ElMessage.success(t('action.saved'))
    drawer.value = false
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    busy.value = false
  }
}

async function submit(row) {
  submitting.value = row.id
  try {
    await api.post(`/api/change-orders/${row.id}/submit`, {})
    ElMessage.success(t('action.saved'))
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    submitting.value = ''
  }
}

async function openDetail(row) {
  detail.value = row
  detailOpen.value = true
  detailLoading.value = true
  detailError.value = ''
  try {
    detail.value = await api.get(`/api/change-orders/${row.id}`)
  } catch (err) {
    detailError.value = msgOf(err)
    ElMessage.error(detailError.value)
  } finally {
    detailLoading.value = false
  }
}

onMounted(() => {
  loadProjects()
  refresh()
})
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input
        v-model="keyword"
        :placeholder="t('f2.changes.search')"
        clearable
        class="search"
        data-test="search"
        @keyup.enter="refresh"
        @clear="refresh"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-select v-model="projectId" clearable filterable class="filter" :placeholder="t('f2.allProjects')" @change="refresh">
        <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
      </el-select>
      <el-select v-model="status" clearable class="filter" :placeholder="t('f2.allStatus')" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`f2.costatus.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openNew">{{ t('f2.changes.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column prop="code" :label="t('f2.changes.code')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="title" :label="t('f2.changes.title')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.title">{{ row.title }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.project')" min-width="150">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.amount')" width="140" align="right">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="String(row.amount)">{{ money(row.amount) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.status')" width="120">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" :type="statusTagType(row.status)">
            {{ t(`f2.costatus.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.errorReason')" min-width="180">
        <template #default="{ row }">
          <span v-if="row.errorMessage" class="fail erp-clamp-2" :title="row.errorMessage" data-test="error-message">
            {{ row.errorMessage }}
          </span>
          <span v-else class="erp-weak">{{ t('f2.noError') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.changes.appliedAt')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ row.appliedAt ? fmtDateTime(row.appliedAt) : t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.createdAt')" width="110">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="200" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ t('f2.detail') }}</el-button>
          <el-button
            v-if="canUpdate() && row.allowed?.includes('pending')"
            link
            type="primary"
            :loading="submitting === row.id"
            data-test="submit"
            @click="submit(row)"
          >
            {{ t('f2.submit') }}
          </el-button>
          <el-button v-if="canUpdate() && row.status === 'draft'" link type="primary" @click="openEdit(row)">
            {{ t('action.edit') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('f2.changes.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f2.changes.hint') }} · {{ t('f2.changes.submitHint') }} · {{ tp('page.loaded', { n: shown.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer
    v-model="drawer"
    :title="editing ? t('f2.changes.edit') : t('f2.changes.new')"
    size="460px"
    data-test="change-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f2.project')" :required="!editing">
        <el-select v-model="form.projectId" filterable :disabled="Boolean(editing)" style="width: 100%">
          <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f2.changes.code')" :required="!editing">
        <el-input v-model="form.code" maxlength="64" :disabled="Boolean(editing)" data-test="f-code" />
      </el-form-item>
      <el-form-item :label="t('f2.changes.title')" required>
        <el-input v-model="form.title" maxlength="64" data-test="f-title" />
      </el-form-item>
      <el-form-item :label="t('f2.amount')" required>
        <el-input v-model="form.amount" type="number" data-test="f-amount" />
      </el-form-item>
      <div class="erp-weak form-hint">{{ t('f2.changes.amountHint') }}</div>
      <el-form-item :label="t('f2.changes.reason')">
        <el-input v-model="form.reason" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer v-model="detailOpen" :title="t('f2.changes.detailTitle')" size="480px" data-test="change-detail">
    <div v-loading="detailLoading" class="detail">
      <el-alert v-if="detailError" type="error" :title="detailError" :closable="false" show-icon />
      <template v-else-if="detail">
        <el-alert
          v-if="detail.errorMessage"
          type="error"
          :title="t('f2.errorReason')"
          :description="detail.errorMessage"
          :closable="false"
          show-icon
          data-test="detail-error"
        />
        <el-descriptions :column="2" border size="small" class="desc">
          <el-descriptions-item :label="t('f2.changes.code')">{{ detail.code }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.status')">{{ t(`f2.costatus.${detail.status}`) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.changes.title')" :span="2">{{ detail.title }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.project')">{{ projectCode(detail.projectId) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.amount')">{{ money(detail.amount) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.changes.approvalStatus')">
            {{ detail.approval ? t(`f2.apstatus.${detail.approval.status}`) : t('common.none') }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f2.changes.appliedAt')">
            {{ detail.appliedAt ? fmtDateTime(detail.appliedAt) : t('common.none') }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f2.changes.reason')" :span="2">
            <span class="erp-clamp-2" :title="detail.reason">{{ detail.reason || t('common.none') }}</span>
          </el-descriptions-item>
        </el-descriptions>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.search {
  width: 220px;
}
.filter {
  width: 170px;
}
.err {
  margin-bottom: 12px;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.fail {
  color: var(--erp-danger);
  font-size: 12px;
  line-height: 1.4;
  word-break: break-word;
}
.form-hint {
  margin: -8px 0 12px;
}
.detail {
  min-height: 140px;
}
.desc {
  margin-top: 12px;
}
@media (max-width: 900px) {
  .search,
  .filter {
    width: 100%;
  }
}
</style>
