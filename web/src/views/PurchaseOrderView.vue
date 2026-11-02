<script setup>
/**
 * 采购单：列表 + 新建抽屉 + 提交审批。
 * 行金额只在前端做展示预估，最终以后端按「分」算出的 amount 为准。
 * 状态推进只认后端 allowed：采购单只有 draft/rejected → pending 走本页提交。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDate, money, shortId } from '../format.js'

const STATUSES = computed(() => dict('poStatus'))

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const status = ref('')

const suppliers = ref([])
const supplierMap = computed(() => new Map(suppliers.value.map((p) => [p.id, p])))
const supplierLabel = (id) => {
  const p = supplierMap.value.get(id)
  return p ? `${p.code} ${p.name}` : ''
}
const supplierName = (id) => supplierMap.value.get(id)?.name ?? (id ? shortId(id) : t('common.none'))

const projects = ref([])
const projectMap = computed(() => new Map(projects.value.map((p) => [p.id, p])))
const projectCode = (id) => projectMap.value.get(id)?.code ?? (id ? shortId(id) : t('common.none'))

const materials = ref([])
const materialMap = computed(() => new Map(materials.value.map((i) => [i.id, i])))
const itemLabel = (id) => {
  const i = materialMap.value.get(id)
  return i ? `${i.code} ${i.name}` : id ? shortId(id) : t('common.none')
}

const drawer = ref(false)
const busy = ref(false)
const form = reactive({ partyId: '', projectId: '', code: '', note: '', lines: [] })

const detailOpen = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
const detailError = ref('')
const submitting = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('purchase:create')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

const estimated = computed(() =>
  form.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0),
)

async function loadLookups() {
  try {
    const data = await api.get('/api/parties?limit=100&partyType=supplier')
    suppliers.value = data.items ?? []
  } catch {
    // 供应商名退化显示 id 前缀
  }
  try {
    const data = await api.get('/api/projects?limit=100')
    projects.value = data.items ?? []
  } catch {
    // 项目编码退化显示 id 前缀
  }
  try {
    const data = await api.get('/api/items?limit=100')
    materials.value = data.items ?? []
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
    if (keyword.value.trim()) qs.set('q', keyword.value.trim())
    if (status.value) qs.set('status', status.value)
    const data = await api.get(`/api/purchase-orders?${qs}`)
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
  return { itemId: '', qty: 1, price: 0 }
}

function openNew() {
  Object.assign(form, { partyId: '', projectId: '', code: '', note: '', lines: [blankLine()] })
  drawer.value = true
}

function addLine() {
  form.lines.push(blankLine())
}

function removeLine(index) {
  form.lines.splice(index, 1)
  if (!form.lines.length) form.lines.push(blankLine())
}

async function save() {
  const lines = form.lines.filter((l) => l.itemId && Number(l.qty) > 0)
  if (!form.partyId || !lines.length) {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    await api.post('/api/purchase-orders', {
      partyId: form.partyId,
      projectId: form.projectId || null,
      ...(form.code.trim() ? { code: form.code.trim() } : {}),
      note: form.note || null,
      lines: lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), price: Number(l.price) || 0 })),
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

async function openDetail(row) {
  detail.value = row
  detailOpen.value = true
  detailLoading.value = true
  detailError.value = ''
  try {
    detail.value = await api.get(`/api/purchase-orders/${row.id}`)
  } catch (err) {
    detailError.value = msgOf(err)
    ElMessage.error(detailError.value)
  } finally {
    detailLoading.value = false
  }
}

async function submit(row) {
  submitting.value = row.id
  try {
    await api.post(`/api/purchase-orders/${row.id}/submit`, { version: row.version })
    ElMessage.success(t('action.saved'))
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    submitting.value = ''
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
      <el-input
        v-model="keyword"
        :placeholder="t('f3.po.search')"
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
      <el-select v-model="status" clearable :placeholder="t('f3.po.status')" class="status" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`f3.status.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openNew">{{ t('f3.po.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="items" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column prop="code" :label="t('f3.po.code')" width="170">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.po.supplier')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="supplierLabel(row.partyId) || supplierName(row.partyId)">
            {{ supplierName(row.partyId) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.po.project')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.po.amount')" width="140" align="right">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="String(row.amount)">{{ money(row.amount) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.po.status')" width="110">
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
      <el-table-column :label="t('f3.po.createdAt')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="170" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ t('f3.po.detail') }}</el-button>
          <el-button
            v-if="canCreate() && row.allowed?.includes('pending')"
            link
            type="success"
            :loading="submitting === row.id"
            @click="submit(row)"
          >
            {{ t('f3.po.submit') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('f3.po.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f3.po.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="drawer" :title="t('f3.po.newTitle')" size="760px" data-test="po-drawer">
    <el-form label-position="top">
      <el-form-item :label="t('f3.po.supplier')" required>
        <el-select v-model="form.partyId" filterable :placeholder="t('f3.po.supplierPick')" style="width: 100%">
          <el-option
            v-for="p in suppliers"
            :key="p.id"
            :value="p.id"
            :label="`${p.code} ${p.name}`"
          />
        </el-select>
        <div v-if="!suppliers.length" class="erp-weak">{{ t('f3.po.noSupplier') }}</div>
      </el-form-item>
      <el-form-item :label="t('f3.po.project')">
        <el-select v-model="form.projectId" filterable clearable :placeholder="t('f3.po.projectPick')" style="width: 100%">
          <el-option
            v-for="p in projects"
            :key="p.id"
            :value="p.id"
            :label="`${p.code} ${p.name}`"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f3.po.code')" required>
        <el-input v-model="form.code" maxlength="64" data-test="po-code"  placeholder="留空自动生成"/>
      </el-form-item>
      <el-form-item :label="t('f3.po.note')">
        <el-input v-model="form.note" type="textarea" :rows="2" maxlength="500" />
      </el-form-item>

      <div class="sec-head">
        <span class="erp-card-title">{{ t('f3.po.lines') }}</span>
        <el-button link type="primary" @click="addLine">{{ t('f3.po.addLine') }}</el-button>
      </div>
      <el-table :data="form.lines" border size="small">
        <el-table-column :label="t('f3.po.item')" min-width="220">
          <template #default="{ row }">
            <el-select v-model="row.itemId" filterable :placeholder="t('f3.po.itemPick')" style="width: 100%">
              <el-option v-for="i in materials" :key="i.id" :value="i.id" :label="`${i.code} ${i.name}`" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column :label="t('f3.po.qty')" width="130">
          <template #default="{ row }">
            <el-input-number v-model="row.qty" :min="0.01" :precision="2" :step="1" controls-position="right" style="width: 100%" />
          </template>
        </el-table-column>
        <el-table-column :label="t('f3.po.price')" width="140">
          <template #default="{ row }">
            <el-input-number v-model="row.price" :min="0" :precision="2" :step="1" controls-position="right" style="width: 100%" />
          </template>
        </el-table-column>
        <el-table-column :label="t('f3.po.lineAmount')" width="120" align="right">
          <template #default="{ row }">{{ money((Number(row.qty) || 0) * (Number(row.price) || 0)) }}</template>
        </el-table-column>
        <el-table-column label="" width="64" align="center">
          <template #default="{ $index }">
            <el-button link type="danger" @click="removeLine($index)">{{ t('f3.po.removeLine') }}</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :image-size="48" :description="t('f3.po.lineEmpty')" />
        </template>
      </el-table>
      <div class="total-line">
        <span class="erp-weak">{{ t('f3.po.frontTotal') }}</span>
        <span class="total">{{ money(estimated) }}</span>
      </div>
      <div class="erp-weak total-note">{{ t('f3.po.totalNote') }}</div>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="po-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer v-model="detailOpen" :title="t('f3.po.detailTitle')" size="760px" data-test="po-detail">
    <div v-loading="detailLoading" class="detail">
      <el-alert v-if="detailError" type="error" :title="detailError" :closable="false" show-icon />
      <div v-if="detail && !detailError" class="detail-head">
        <span class="code">{{ detail.code }}</span>
        <span class="erp-ellipsis" :title="supplierName(detail.partyId)">{{ supplierName(detail.partyId) }}</span>
        <el-tag size="small" round effect="plain">{{ t(`f3.status.${detail.status}`) }}</el-tag>
        <span class="amount">{{ money(detail.amount) }}</span>
      </div>
      <div v-if="detail?.note && !detailError" class="erp-weak note-body erp-clamp-2" :title="detail.note">
        {{ detail.note }}
      </div>
      <el-table v-if="!detailError" :data="detail?.lines ?? []" border size="small">
        <el-table-column prop="lineNo" :label="t('line.no')" width="60" align="center" />
        <el-table-column :label="t('f3.po.item')" min-width="180">
          <template #default="{ row }">
            <span class="erp-ellipsis" :title="itemLabel(row.itemId)">{{ itemLabel(row.itemId) }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('f3.po.ordered')" width="90" align="right">
          <template #default="{ row }">{{ row.qty }}</template>
        </el-table-column>
        <el-table-column :label="t('f3.po.received')" width="90" align="right">
          <template #default="{ row }">{{ row.receivedQty }}</template>
        </el-table-column>
        <el-table-column :label="t('f3.po.remaining')" width="90" align="right">
          <template #default="{ row }">{{ row.remainingQty }}</template>
        </el-table-column>
        <el-table-column :label="t('f3.po.price')" width="110" align="right">
          <template #default="{ row }">{{ money(row.price) }}</template>
        </el-table-column>
        <el-table-column :label="t('f3.po.lineAmount')" width="120" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <template #empty>
          <el-empty :image-size="48" :description="t('f3.po.lineEmpty')" />
        </template>
      </el-table>
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
.code,
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 0 8px;
}
.total-line {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
}
.total {
  font-size: 18px;
  font-weight: 600;
  color: var(--erp-text);
}
.total-note {
  text-align: right;
  margin-top: 2px;
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
.detail-head .amount {
  margin-left: auto;
  font-weight: 600;
}
.note-body {
  margin-bottom: 12px;
}
@media (max-width: 900px) {
  .search,
  .status {
    width: 100%;
  }
  .total-line {
    justify-content: flex-start;
  }
  .total-note {
    text-align: left;
  }
}
</style>
