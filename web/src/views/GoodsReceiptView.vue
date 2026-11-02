<script setup>
/**
 * 收货单：选已审批 PO，按 PO 行填本次收货数量，行上显示已收 / 剩余。
 * 列表接口不接 q，搜索只过滤已加载记录；超量收货由后端 409，details.reason 原样展示。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDate, money, shortId } from '../format.js'

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')

const purchaseOrders = ref([])
const poMap = computed(() => new Map(purchaseOrders.value.map((p) => [p.id, p])))
const poCode = (id) => poMap.value.get(id)?.code ?? (id ? shortId(id) : t('common.none'))

const warehouses = ref([])
const warehouseMap = computed(() => new Map(warehouses.value.map((w) => [w.id, w])))
const warehouseName = (id) => warehouseMap.value.get(id)?.name ?? (id ? shortId(id) : t('common.none'))

const materials = ref([])
const materialMap = computed(() => new Map(materials.value.map((i) => [i.id, i])))
const itemLabel = (id) => {
  const i = materialMap.value.get(id)
  return i ? `${i.code} ${i.name}` : id ? shortId(id) : t('common.none')
}

const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return items.value
  return items.value.filter((row) =>
    [row.code, poCode(row.poId), warehouseName(row.warehouseId)]
      .some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})

const drawer = ref(false)
const busy = ref(false)
const poLoading = ref(false)
const form = reactive({ poId: '', warehouseId: '', code: '', receivedAt: null, note: '', lines: [] })

const detailOpen = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
const detailError = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('purchase:create')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

const formTotal = computed(() =>
  form.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0),
)

async function loadLookups() {
  try {
    const data = await api.get('/api/items?limit=100')
    materials.value = data.items ?? []
  } catch {
    // 物料名退化显示 id 前缀
  }
  try {
    const data = await api.get('/api/warehouses?limit=100')
    warehouses.value = data.items ?? []
  } catch {
    // 仓库名退化显示 id 前缀
  }

  /** 只有 approved / closed 的采购单能收货；分两次拉再合并去重。 */
  const all = []
  for (const st of ['approved', 'closed']) {
    try {
      const data = await api.get(`/api/purchase-orders?limit=100&status=${st}`)
      all.push(...(data.items ?? []))
    } catch {
      // 某一状态拉不到不影响收货列表本身
    }
  }
  const seen = new Set()
  purchaseOrders.value = all.filter((p) => {
    if (seen.has(p.id)) return false
    seen.add(p.id)
    return true
  })
}

async function load(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    const data = await api.get(`/api/goods-receipts?${qs}`)
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
  Object.assign(form, { poId: '', warehouseId: '', code: '', receivedAt: null, note: '', lines: [] })
  drawer.value = true
}

async function onPoChange(id) {
  form.lines = []
  if (!id) return
  poLoading.value = true
  try {
    const po = await api.get(`/api/purchase-orders/${id}`)
    form.lines = (po.lines ?? []).map((l) => ({
      poLineId: l.id,
      itemId: l.itemId,
      price: l.price,
      ordered: l.qty,
      received: l.receivedQty,
      remaining: l.remainingQty,
      qty: 0,
    }))
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    poLoading.value = false
  }
}

async function save() {
  const lines = form.lines.filter((l) => Number(l.qty) > 0)
  if (!form.poId || !form.warehouseId || !lines.length) {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    const payload = {
      poId: form.poId,
      warehouseId: form.warehouseId,
      lines: lines.map((l) => ({ poLineId: l.poLineId, qty: Number(l.qty) })),
    }
    if (form.code.trim()) payload.code = form.code.trim()
    if (form.receivedAt) payload.receivedAt = form.receivedAt
    if (form.note) payload.note = form.note
    await api.post('/api/goods-receipts', payload)
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
    detail.value = await api.get(`/api/goods-receipts/${row.id}`)
  } catch (err) {
    detailError.value = msgOf(err)
    ElMessage.error(detailError.value)
  } finally {
    detailLoading.value = false
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
      <el-input v-model="keyword" :placeholder="t('f3.grn.search')" clearable class="search" data-test="search">
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openNew">{{ t('f3.grn.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column prop="code" :label="t('f3.grn.code')" width="190">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.grn.po')" width="170">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="poCode(row.poId)">{{ poCode(row.poId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.grn.warehouse')" min-width="150">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="warehouseName(row.warehouseId)">{{ warehouseName(row.warehouseId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.grn.receivedAt')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.receivedAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.grn.status')" width="100">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" type="success">{{ t(`f3.status.${row.status}`) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.grn.note')" min-width="160">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.note || ''">{{ row.note || t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="100" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ t('f3.grn.detail') }}</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="keyword.trim() ? t('common.noMatch') : t('f3.grn.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f3.grn.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
      <template v-if="keyword.trim()"> · {{ t('common.clientFilter') }}</template>
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="drawer" :title="t('f3.grn.newTitle')" size="820px" data-test="grn-drawer">
    <el-form label-position="top">
      <el-form-item :label="t('f3.grn.po')" required>
        <el-select
          v-model="form.poId"
          filterable
          :placeholder="t('f3.grn.poPick')"
          style="width: 100%"
          @change="onPoChange"
        >
          <el-option v-for="p in purchaseOrders" :key="p.id" :value="p.id" :label="`${p.code} · ${money(p.amount)}`" />
        </el-select>
        <div v-if="!purchaseOrders.length" class="erp-weak">{{ t('f3.grn.noPo') }}</div>
      </el-form-item>
      <el-form-item :label="t('f3.grn.warehouse')" required>
        <el-select v-model="form.warehouseId" filterable :placeholder="t('f3.grn.warehousePick')" style="width: 100%">
          <el-option v-for="w in warehouses" :key="w.id" :value="w.id" :label="`${w.code} ${w.name}`" />
        </el-select>
        <div v-if="!warehouses.length" class="erp-weak">{{ t('f3.grn.noWarehouse') }}</div>
      </el-form-item>
      <el-form-item :label="t('f3.grn.code')">
        <el-input v-model="form.code" maxlength="64" :placeholder="t('f3.grn.autoCode')" />
      </el-form-item>
      <el-form-item :label="t('f3.grn.receivedAt')">
        <el-date-picker v-model="form.receivedAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f3.grn.note')">
        <el-input v-model="form.note" type="textarea" :rows="2" maxlength="500" />
      </el-form-item>

      <div class="sec-head">
        <span class="erp-card-title">{{ t('f3.grn.lines') }}</span>
        <span class="erp-weak">{{ t('f3.grn.remainingHint') }}</span>
      </div>
      <el-table v-loading="poLoading" :data="form.lines" border size="small">
        <el-table-column :label="t('f3.grn.item')" min-width="180">
          <template #default="{ row }">
            <span class="erp-ellipsis" :title="itemLabel(row.itemId)">{{ itemLabel(row.itemId) }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('f3.grn.ordered')" width="90" align="right">
          <template #default="{ row }">{{ row.ordered }}</template>
        </el-table-column>
        <el-table-column :label="t('f3.grn.received')" width="90" align="right">
          <template #default="{ row }">{{ row.received }}</template>
        </el-table-column>
        <el-table-column :label="t('f3.grn.remaining')" width="90" align="right">
          <template #default="{ row }">
            <span :class="{ danger: Number(row.remaining) <= 0 }">{{ row.remaining }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('f3.grn.thisQty')" width="140">
          <template #default="{ row }">
            <el-input-number
              v-model="row.qty"
              :min="0"
              :max="Number(row.remaining)"
              :precision="2"
              :step="1"
              :disabled="Number(row.remaining) <= 0"
              controls-position="right"
              style="width: 100%"
            />
          </template>
        </el-table-column>
        <el-table-column :label="t('f3.grn.lineAmount')" width="120" align="right">
          <template #default="{ row }">{{ money((Number(row.qty) || 0) * (Number(row.price) || 0)) }}</template>
        </el-table-column>
        <template #empty>
          <el-empty :image-size="48" :description="t('f3.grn.pickPoFirst')" />
        </template>
      </el-table>
      <div class="total-line">
        <span class="erp-weak">{{ t('f3.grn.frontTotal') }}</span>
        <span class="total">{{ money(formTotal) }}</span>
      </div>
      <div class="erp-weak total-note">{{ t('f3.po.totalNote') }}</div>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="grn-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer v-model="detailOpen" :title="t('f3.grn.detailTitle')" size="720px" data-test="grn-detail">
    <div v-loading="detailLoading" class="detail">
      <el-alert v-if="detailError" type="error" :title="detailError" :closable="false" show-icon />
      <div v-if="detail && !detailError" class="detail-head">
        <span class="code">{{ detail.code }}</span>
        <span class="erp-weak">{{ poCode(detail.poId) }}</span>
        <span class="erp-weak">{{ warehouseName(detail.warehouseId) }}</span>
        <el-tag size="small" round effect="plain" type="success">{{ t(`f3.status.${detail.status}`) }}</el-tag>
      </div>
      <el-table v-if="!detailError" :data="detail?.lines ?? []" border size="small">
        <el-table-column :label="t('f3.grn.item')" min-width="190">
          <template #default="{ row }">
            <span class="erp-ellipsis" :title="itemLabel(row.itemId)">{{ itemLabel(row.itemId) }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('f3.grn.thisQty')" width="100" align="right">
          <template #default="{ row }">{{ row.qty }}</template>
        </el-table-column>
        <el-table-column :label="t('f3.po.price')" width="110" align="right">
          <template #default="{ row }">{{ money(row.price) }}</template>
        </el-table-column>
        <el-table-column :label="t('f3.grn.lineAmount')" width="120" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
        <template #empty>
          <el-empty :image-size="48" :description="t('f3.grn.lineEmpty')" />
        </template>
      </el-table>
    </div>
  </el-drawer>
</template>

<style scoped>
.search {
  width: 260px;
}
.err {
  margin-bottom: 12px;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
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
.danger {
  color: var(--erp-danger);
}
@media (max-width: 900px) {
  .search {
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
