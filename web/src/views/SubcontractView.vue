<script setup>
/**
 * 分包：列表 + 新建 + 提交审批；进度款在抽屉里申请并逐条提交审批。
 * 合同/进度款的 allowed 都来自后端，本页不自己推状态机。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDate, money, shortId } from '../format.js'

const STATUSES = ['draft', 'pending', 'approved', 'rejected', 'closed']

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const status = ref('')

const projects = ref([])
const projectMap = computed(() => new Map(projects.value.map((p) => [p.id, p])))
const projectCode = (id) => projectMap.value.get(id)?.code ?? (id ? shortId(id) : t('common.none'))

const suppliers = ref([])
const supplierMap = computed(() => new Map(suppliers.value.map((p) => [p.id, p])))
const supplierLabel = (id) => {
  const p = supplierMap.value.get(id)
  return p ? `${p.code} ${p.name}` : ''
}
const supplierName = (id) => supplierMap.value.get(id)?.name ?? (id ? shortId(id) : t('common.none'))

const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return items.value
  return items.value.filter((row) =>
    [row.code, row.name, projectCode(row.projectId), supplierName(row.partyId)]
      .some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})

const drawer = ref(false)
const busy = ref(false)
const form = reactive({ projectId: '', partyId: '', code: '', name: '', amount: 0, note: '' })
const submitting = ref('')

const progressOpen = ref(false)
const progressFor = ref(null)
const progressDetail = ref(null)
const progressLoading = ref(false)
const progressError = ref('')
const progressForm = reactive({ seq: 1, amount: 0, note: '' })
const progressBusy = ref(false)
const progressSubmitting = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('subcontract:create')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)
const canProgress = computed(
  () => progressDetail.value && ['approved', 'closed'].includes(progressDetail.value.status),
)

async function loadLookups() {
  try {
    const data = await api.get('/api/projects?limit=100')
    projects.value = data.items ?? []
  } catch {
    // 项目编码退化显示 id 前缀
  }
  try {
    const data = await api.get('/api/parties?limit=100&partyType=supplier')
    suppliers.value = data.items ?? []
  } catch {
    // 供应商名退化显示 id 前缀
  }
}

async function load(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    if (status.value) qs.set('status', status.value)
    const data = await api.get(`/api/subcontracts?${qs}`)
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
  Object.assign(form, { projectId: '', partyId: '', code: '', name: '', amount: 0, note: '' })
  drawer.value = true
}

async function save() {
  if (!form.projectId || !form.partyId || !form.code.trim() || !form.name.trim() || !(Number(form.amount) > 0)) {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    await api.post('/api/subcontracts', {
      projectId: form.projectId,
      partyId: form.partyId,
      code: form.code.trim(),
      name: form.name.trim(),
      amount: Number(form.amount),
      note: form.note || null,
    })
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
    await api.post(`/api/subcontracts/${row.id}/submit`, { version: row.version })
    ElMessage.success(t('action.saved'))
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    submitting.value = ''
  }
}

async function loadProgress() {
  if (!progressFor.value) return
  progressLoading.value = true
  progressError.value = ''
  try {
    progressDetail.value = await api.get(`/api/subcontracts/${progressFor.value.id}`)
    const maxSeq = Math.max(0, ...(progressDetail.value.progress ?? []).map((p) => Number(p.seq) || 0))
    progressForm.seq = maxSeq + 1
  } catch (err) {
    progressError.value = msgOf(err)
    ElMessage.error(progressError.value)
  } finally {
    progressLoading.value = false
  }
}

async function openProgress(row) {
  progressFor.value = row
  progressDetail.value = null
  progressOpen.value = true
  Object.assign(progressForm, { seq: 1, amount: 0, note: '' })
  await loadProgress()
}

async function addProgress() {
  if (!(Number(progressForm.amount) > 0) || !Number.isInteger(Number(progressForm.seq))) {
    ElMessage.warning(t('common.required'))
    return
  }
  progressBusy.value = true
  try {
    const payload = {
      seq: Number(progressForm.seq),
      amount: Number(progressForm.amount),
    }
    if (progressForm.note) payload.note = progressForm.note
    await api.post(`/api/subcontracts/${progressFor.value.id}/progress`, payload)
    ElMessage.success(t('action.saved'))
    Object.assign(progressForm, { amount: 0, note: '' })
    await loadProgress()
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    progressBusy.value = false
  }
}

async function submitProgress(p) {
  progressSubmitting.value = p.id
  try {
    await api.post(`/api/subcontracts/${progressFor.value.id}/progress/${p.id}/submit`, { version: p.version })
    ElMessage.success(t('action.saved'))
    await loadProgress()
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    progressSubmitting.value = ''
  }
}

onMounted(() => {
  loadLookups()
  refresh()
})
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input v-model="keyword" :placeholder="t('f3.sub.search')" clearable class="search" data-test="search">
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-select v-model="status" clearable :placeholder="t('f3.sub.status')" class="status" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`f3.status.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openNew">{{ t('f3.sub.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="openProgress">
      <el-table-column prop="code" :label="t('f3.sub.code')" width="170">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" :label="t('f3.sub.name')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.sub.project')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.sub.supplier')" min-width="170">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="supplierLabel(row.partyId) || supplierName(row.partyId)">
            {{ supplierName(row.partyId) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.sub.amount')" width="140" align="right">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="String(row.amount)">{{ money(row.amount) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.sub.status')" width="110">
        <template #default="{ row }">
          <el-tag
            size="small"
            round
            effect="plain"
            :type="row.status === 'approved' ? 'success' : row.status === 'rejected' ? 'danger' : row.status === 'pending' ? 'warning' : 'info'"
          >
            {{ t(`f3.status.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.sub.createdAt')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="190" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openProgress(row)">{{ t('f3.sub.progress') }}</el-button>
          <el-button
            v-if="canCreate() && row.allowed?.includes('pending')"
            link
            type="success"
            :loading="submitting === row.id"
            @click="submit(row)"
          >
            {{ t('f3.sub.submit') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="keyword.trim() ? t('common.noMatch') : t('f3.sub.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f3.sub.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
      <template v-if="keyword.trim()"> · {{ t('common.clientFilter') }}</template>
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="drawer" :title="t('f3.sub.newTitle')" size="520px" data-test="sub-drawer">
    <el-form label-position="top">
      <el-form-item :label="t('f3.sub.project')" required>
        <el-select v-model="form.projectId" filterable :placeholder="t('f3.sub.projectPick')" style="width: 100%">
          <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f3.sub.supplier')" required>
        <el-select v-model="form.partyId" filterable :placeholder="t('f3.sub.supplierPick')" style="width: 100%">
          <el-option v-for="p in suppliers" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f3.sub.code')" required>
        <el-input v-model="form.code" maxlength="64" />
      </el-form-item>
      <el-form-item :label="t('f3.sub.name')" required>
        <el-input v-model="form.name" maxlength="64" />
      </el-form-item>
      <el-form-item :label="t('f3.sub.amount')" required>
        <el-input-number v-model="form.amount" :min="0.01" :precision="2" :step="1000" controls-position="right" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f3.sub.note')">
        <el-input v-model="form.note" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="sub-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer v-model="progressOpen" :title="t('f3.sub.progressTitle')" size="720px" data-test="sub-progress">
    <div v-loading="progressLoading" class="detail">
      <el-alert v-if="progressError" type="error" :title="progressError" :closable="false" show-icon />

      <div v-if="progressDetail && !progressError" class="detail-head">
        <span class="code">{{ progressDetail.code }}</span>
        <span class="erp-ellipsis" :title="progressDetail.name">{{ progressDetail.name }}</span>
        <el-tag size="small" round effect="plain">{{ t(`f3.status.${progressDetail.status}`) }}</el-tag>
      </div>

      <el-descriptions v-if="progressDetail && !progressError" :column="2" border size="small">
        <el-descriptions-item :label="t('f3.sub.contractAmount')">{{ money(progressDetail.amount) }}</el-descriptions-item>
        <el-descriptions-item :label="t('f3.sub.progressAmount')">{{ money(progressDetail.progressAmount) }}</el-descriptions-item>
        <el-descriptions-item :label="t('f3.sub.remainingAmount')">{{ money(progressDetail.remainingAmount) }}</el-descriptions-item>
        <el-descriptions-item :label="t('f3.sub.supplier')">{{ supplierName(progressDetail.partyId) }}</el-descriptions-item>
      </el-descriptions>

      <el-alert
        v-if="progressDetail && !canProgress && !progressError"
        class="tip"
        type="info"
        :title="t('f3.sub.needApproved')"
        :closable="false"
        show-icon
      />

      <div class="sec-head">
        <span class="erp-card-title">{{ t('f3.sub.progressList') }}</span>
      </div>
      <el-table v-if="!progressError" :data="progressDetail?.progress ?? []" border size="small">
        <el-table-column prop="seq" :label="t('f3.sub.seq')" width="70" align="center" />
        <el-table-column :label="t('f3.sub.amount')" width="140" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <el-table-column :label="t('f3.sub.status')" width="110">
          <template #default="{ row }">
            <el-tag
              size="small"
              round
              effect="plain"
              :type="row.status === 'approved' ? 'success' : row.status === 'rejected' ? 'danger' : row.status === 'pending' ? 'warning' : 'info'"
            >
              {{ t(`f3.status.${row.status}`) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column :label="t('f3.sub.progressNote')" min-width="140">
          <template #default="{ row }">
            <span class="erp-ellipsis" :title="row.note || ''">{{ row.note || t('common.none') }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="''" width="90" align="right">
          <template #default="{ row }">
            <el-button
              v-if="canCreate() && row.allowed?.includes('pending')"
              link
              type="success"
              :loading="progressSubmitting === row.id"
              @click="submitProgress(row)"
            >
              {{ t('f3.sub.submit') }}
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :image-size="48" :description="t('f3.sub.progressEmpty')" />
        </template>
      </el-table>

      <template v-if="canProgress && canCreate() && !progressError">
        <div class="sec-head">
          <span class="erp-card-title">{{ t('f3.sub.addProgress') }}</span>
        </div>
        <el-form label-position="top">
          <el-form-item :label="t('f3.sub.seq')">
            <el-input-number v-model="progressForm.seq" :min="1" :step="1" :precision="0" controls-position="right" style="width: 100%" />
          </el-form-item>
          <el-form-item :label="t('f3.sub.amount')" required>
            <el-input-number v-model="progressForm.amount" :min="0.01" :precision="2" :step="1000" controls-position="right" style="width: 100%" />
          </el-form-item>
          <el-form-item :label="t('f3.sub.progressNote')">
            <el-input v-model="progressForm.note" type="textarea" :rows="2" maxlength="500" />
          </el-form-item>
          <div class="right">
            <el-button type="primary" :loading="progressBusy" @click="addProgress">
              {{ t('f3.sub.addProgress') }}
            </el-button>
          </div>
        </el-form>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.search {
  width: 240px;
}
.status {
  width: 140px;
}
.err {
  margin-bottom: 12px;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.detail {
  min-height: 120px;
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  min-width: 0;
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 16px 0 8px;
}
.tip {
  margin-top: 12px;
}
.right {
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 900px) {
  .search,
  .status {
    width: 100%;
  }
}
</style>
