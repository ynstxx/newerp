<script setup>
/**
 * 领料单：建单（含明细行）→ 提交审批 → 审批通过后后端出库。
 *
 * 关键点：审批通过但出库失败（库存不足）时，单据落 status=failed 且带上
 * errorMessage —— 这是唯一能看到失败原因的地方，所以列表专门留一列显示它，
 * 详情抽屉里再用 el-alert 完整展示一遍，绝不吞掉。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDateTime, money, shortId } from '../format.js'

const STATUSES = ['draft', 'pending', 'issued', 'rejected', 'failed', 'cancelled']

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

const warehouses = ref([])
const warehouseMap = computed(() => new Map(warehouses.value.map((w) => [w.id, w])))
const warehouseName = (id) => {
  const w = warehouseMap.value.get(id)
  return w ? (w.name || w.code) : (id ? shortId(id) : t('common.none'))
}

const goods = ref([])
const itemMap = computed(() => new Map(goods.value.map((i) => [i.id, i])))
const itemLabel = (id) => {
  const i = itemMap.value.get(id)
  return i ? `${i.code} ${i.name}` : (id ? shortId(id) : t('common.none'))
}

/** 后端 list 不接 q：搜索只过滤已加载的行 */
const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return items.value
  return items.value.filter((row) =>
    [row.code, projectCode(row.projectId), warehouseName(row.warehouseId)]
      .some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const submitting = ref('')
const form = reactive({ projectId: '', code: '', warehouseId: '', note: '', lines: [] })

const detailOpen = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
/** 详情接口失败：抽屉里给原因，不假装“没有明细” */
const detailError = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('work:create')
const canUpdate = () => has('work:update')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

/** 前端只做预估展示，落库金额以后端为准 */
const estimate = computed(() =>
  form.lines.reduce((sum, l) => sum + Number(l.qty || 0) * Number(l.unitCost || 0), 0),
)

async function loadLookups() {
  try {
    const data = await api.get('/api/projects?limit=100')
    projects.value = data.items ?? []
  } catch {
    // 项目编码退化显示 id 前缀
  }
  try {
    const data = await api.get('/api/warehouses?limit=100')
    warehouses.value = data.items ?? []
  } catch {
    // 仓库名退化显示 id 前缀
  }
  try {
    const data = await api.get('/api/items?limit=100')
    goods.value = data.items ?? []
  } catch {
    // 物料名退化显示 id 前缀
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
    const data = await api.get(`/api/material-issues?${qs}`)
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

function blankLine() {
  return { itemId: '', qty: 1, unitCost: '', note: '' }
}

function openNew() {
  editing.value = null
  Object.assign(form, {
    projectId: projectId.value || '',
    code: '',
    warehouseId: warehouses.value[0]?.id ?? '',
    note: '',
    lines: [blankLine()],
  })
  drawer.value = true
}

async function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    projectId: row.projectId ?? '',
    code: row.code ?? '',
    warehouseId: row.warehouseId ?? '',
    note: row.note ?? '',
    lines: [blankLine()],
  })
  drawer.value = true
  try {
    const data = await api.get(`/api/material-issues/${row.id}`)
    form.lines = (data.lines ?? []).map((l) => ({
      itemId: l.itemId,
      qty: Number(l.qty),
      unitCost: l.unitCost == null ? '' : Number(l.unitCost),
      note: l.note ?? '',
    }))
    if (!form.lines.length) form.lines = [blankLine()]
  } catch (err) {
    ElMessage.error(msgOf(err))
  }
}

function addLine() {
  form.lines.push(blankLine())
}

function removeLine(index) {
  form.lines.splice(index, 1)
  if (!form.lines.length) form.lines.push(blankLine())
}

async function save() {
  if (!form.projectId || !form.warehouseId) {
    ElMessage.warning(t('common.required'))
    return
  }
  const lines = form.lines
    .filter((l) => l.itemId && Number(l.qty) > 0)
    .map((l) => ({
      itemId: l.itemId,
      qty: Number(l.qty),
      unitCost: l.unitCost === '' || l.unitCost === null ? null : Number(l.unitCost),
      note: l.note || null,
    }))
  if (!lines.length) {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    if (editing.value) {
      await api.patch(`/api/material-issues/${editing.value.id}`, {
        warehouseId: form.warehouseId,
        note: form.note || null,
        lines,
        version: editing.value.version,
      })
    } else {
      await api.post('/api/material-issues', {
        projectId: form.projectId,
        ...(form.code.trim() ? { code: form.code.trim() } : {}),
        warehouseId: form.warehouseId,
        note: form.note || null,
        lines,
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
    const data = await api.post(`/api/material-issues/${row.id}/submit`, {})
    // 提交本身失败（如没有明细）会有 reason；出库失败要等审批人同意后才出现
    if (data?.errorMessage) ElMessage.error(data.errorMessage)
    else ElMessage.success(t('action.saved'))
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
    detail.value = await api.get(`/api/material-issues/${row.id}`)
  } catch (err) {
    detailError.value = msgOf(err)
    ElMessage.error(detailError.value)
  } finally {
    detailLoading.value = false
  }
}

const statusTagType = (s) =>
  s === 'issued' ? 'success' : s === 'failed' || s === 'rejected' ? 'danger' : s === 'pending' ? 'warning' : 'info'

onMounted(() => {
  loadLookups()
  refresh()
})
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input
        v-model="keyword"
        :placeholder="t('f2.issues.search')"
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
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`f2.mistatus.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openNew">{{ t('f2.issues.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column prop="code" :label="t('f2.issues.code')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.project')" min-width="160">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.warehouse')" min-width="150">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="warehouseName(row.warehouseId)">{{ warehouseName(row.warehouseId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.amount')" width="130" align="right">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="String(row.amount)">{{ money(row.amount) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.status')" width="120">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" :type="statusTagType(row.status)">
            {{ t(`f2.mistatus.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <!-- 库存不足 / 出库被拒的唯一可见线索：整段原因放 title，列表里两行截断 -->
      <el-table-column :label="t('f2.errorReason')" min-width="200">
        <template #default="{ row }">
          <span
            v-if="row.errorMessage"
            class="fail erp-clamp-2"
            :title="row.errorMessage"
            data-test="error-message"
          >
            {{ row.errorMessage }}
          </span>
          <span v-else class="erp-weak">{{ t('f2.noError') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.createdAt')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDateTime(row.createdAt) }}</span>
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
        <el-empty :image-size="64" :description="t('f2.issues.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f2.issues.hint') }} · {{ t('f2.issues.submitHint') }} · {{ tp('page.loaded', { n: shown.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer
    v-model="drawer"
    :title="editing ? t('f2.issues.edit') : t('f2.issues.new')"
    size="680px"
    data-test="issue-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f2.project')" required>
        <el-select v-model="form.projectId" filterable :disabled="Boolean(editing)" style="width: 100%">
          <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f2.issues.code')" required>
        <el-input v-model="form.code" maxlength="64" :disabled="Boolean(editing)" data-test="f-code"  placeholder="留空自动生成"/>
      </el-form-item>
      <el-form-item :label="t('f2.warehouse')" required>
        <el-select
          v-model="form.warehouseId"
          filterable
          style="width: 100%"
          :placeholder="warehouses.length ? t('f2.issues.warehousePick') : t('f2.issues.warehouseEmpty')"
        >
          <el-option v-for="w in warehouses" :key="w.id" :value="w.id" :label="`${w.code} ${w.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f2.note')">
        <el-input v-model="form.note" type="textarea" :rows="2" maxlength="500" />
      </el-form-item>

      <div class="erp-card-head lines-head">
        <span class="erp-card-title">{{ t('f2.issues.lines') }}</span>
        <el-button link type="primary" @click="addLine">{{ t('f2.issues.addLine') }}</el-button>
      </div>
      <el-table :data="form.lines" size="small" border>
        <el-table-column type="index" :label="t('line.no')" width="48" />
        <el-table-column :label="t('f2.issues.item')" min-width="200">
          <template #default="{ row }">
            <el-select
              v-model="row.itemId"
              filterable
              style="width: 100%"
              :placeholder="goods.length ? t('f2.issues.itemPick') : t('f2.issues.itemEmpty')"
            >
              <el-option v-for="g in goods" :key="g.id" :value="g.id" :label="`${g.code} ${g.name}`" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column :label="t('f2.issues.qty')" width="110">
          <template #default="{ row }">
            <el-input v-model="row.qty" type="number" min="0" />
          </template>
        </el-table-column>
        <el-table-column :label="t('f2.issues.unitCost')" width="120">
          <template #default="{ row }">
            <el-input v-model="row.unitCost" type="number" min="0" />
          </template>
        </el-table-column>
        <el-table-column :label="t('f2.issues.lineNote')" min-width="120">
          <template #default="{ row }">
            <el-input v-model="row.note" maxlength="500" />
          </template>
        </el-table-column>
        <el-table-column :label="''" width="70" align="right">
          <template #default="{ $index }">
            <el-button link type="danger" @click="removeLine($index)">{{ t('f2.issues.removeLine') }}</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :image-size="40" :description="t('f2.issues.lineEmpty')" />
        </template>
      </el-table>
      <div class="erp-weak lines-hint">
        {{ t('f2.issues.linesHint') }} · {{ t('common.total') }} {{ money(estimate) }}
      </div>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer v-model="detailOpen" :title="t('f2.issues.detailTitle')" size="560px" data-test="issue-detail">
    <div v-loading="detailLoading" class="detail">
      <el-alert v-if="detailError" type="error" :title="detailError" :closable="false" show-icon />
      <template v-else-if="detail">
        <el-alert
          v-if="detail.errorMessage"
          type="error"
          :title="t('f2.issues.failedTitle')"
          :description="detail.errorMessage"
          :closable="false"
          show-icon
          data-test="detail-error"
        />
        <el-descriptions :column="2" border size="small" class="desc">
          <el-descriptions-item :label="t('f2.issues.code')">{{ detail.code }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.status')">
            {{ t(`f2.mistatus.${detail.status}`) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f2.project')">{{ projectCode(detail.projectId) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.warehouse')">{{ warehouseName(detail.warehouseId) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.amount')">{{ money(detail.amount) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.issues.approvalStatus')">
            {{ detail.approval ? t(`f2.apstatus.${detail.approval.status}`) : t('common.none') }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f2.createdAt')" :span="2">
            {{ fmtDateTime(detail.createdAt) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f2.note')" :span="2">
            <span class="erp-clamp-2" :title="detail.note">{{ detail.note || t('common.none') }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <div class="erp-card-head lines-head">
          <span class="erp-card-title">{{ t('f2.issues.lines') }}</span>
        </div>
        <el-table :data="detail.lines ?? []" size="small" border>
          <el-table-column :label="t('f2.issues.item')" min-width="180">
            <template #default="{ row }">
              <span class="erp-ellipsis" :title="itemLabel(row.itemId)">{{ itemLabel(row.itemId) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f2.issues.qty')" width="90" align="right">
            <template #default="{ row }">{{ Number(row.qty) }}</template>
          </el-table-column>
          <el-table-column :label="t('f2.issues.unitCost')" width="110" align="right">
            <template #default="{ row }">
              <span v-if="row.unitCost != null">{{ money(row.unitCost) }}</span>
              <span v-else class="erp-weak">{{ t('common.none') }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :image-size="40" :description="t('f2.issues.lineEmpty')" />
          </template>
        </el-table>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.search {
  width: 220px;
}
.filter {
  width: 180px;
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
.lines-head {
  margin-top: var(--erp-gap);
}
.lines-hint {
  margin-top: 8px;
}
.detail {
  min-height: 160px;
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
