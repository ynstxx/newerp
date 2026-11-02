<script setup>
/**
 * 服务合同：列表 + 新建/编辑/删除。
 * 响应 / 解决时限（分钟）决定工单 SLA，所以放在列表里直接可见。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { dateInput, fmtDate, money, shortId } from '../format.js'

const STATUSES = ['active', 'expired', 'terminated']

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const status = ref('')

const parties = ref([])
const partyMap = computed(() => new Map(parties.value.map((p) => [p.id, p])))
const partyName = (id) => partyMap.value.get(id)?.name ?? (id ? shortId(id) : t('common.none'))
const partyLabel = (id) => {
  const p = partyMap.value.get(id)
  return p ? `${p.code} ${p.name}` : partyName(id)
}

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const removing = ref('')
const form = reactive({
  code: '',
  name: '',
  partyId: '',
  startAt: null,
  endAt: null,
  slaLevel: '',
  responseMinutes: null,
  resolveMinutes: null,
  amount: null,
  status: 'active',
})

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('service_contract:create')
const canUpdate = () => has('service_contract:update')
const canDelete = () => has('service_contract:delete')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

async function loadParties() {
  try {
    parties.value = (await api.get('/api/parties?limit=100')).items ?? []
  } catch {
    // 客户名退化为短 id
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
    const data = await api.get(`/api/service-contracts?${qs}`)
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

function openCreate() {
  editing.value = null
  Object.assign(form, {
    code: '',
    name: '',
    partyId: '',
    startAt: null,
    endAt: null,
    slaLevel: '',
    responseMinutes: null,
    resolveMinutes: null,
    amount: null,
    status: 'active',
  })
  drawer.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    code: row.code ?? '',
    name: row.name ?? '',
    partyId: row.partyId ?? '',
    startAt: dateInput(row.startAt) || null,
    endAt: dateInput(row.endAt) || null,
    slaLevel: row.slaLevel ?? '',
    responseMinutes: row.responseMinutes ?? null,
    resolveMinutes: row.resolveMinutes ?? null,
    amount: row.amount ?? null,
    status: row.status ?? 'active',
  })
  drawer.value = true
}

async function save() {
  if (!form.name.trim() || !form.partyId) {
    ElMessage.warning(t('f4.svc.required'))
    return
  }
  const body = {
    ...(form.code.trim() ? { code: form.code.trim() } : {}),
    name: form.name.trim(),
    partyId: form.partyId,
    startAt: form.startAt || null,
    endAt: form.endAt || null,
    slaLevel: form.slaLevel || null,
    responseMinutes: form.responseMinutes ?? null,
    resolveMinutes: form.resolveMinutes ?? null,
    amount: form.amount ?? null,
  }
  busy.value = true
  try {
    if (editing.value) {
      await api.patch(`/api/service-contracts/${editing.value.id}`, {
        ...body,
        status: form.status,
        version: editing.value.version,
      })
    } else {
      await api.post('/api/service-contracts', body)
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

async function remove(row) {
  try {
    await ElMessageBox.confirm(t('f4.svc.deleteConfirm'), row.code, {
      confirmButtonText: t('f4.svc.delete'),
      cancelButtonText: t('action.cancel'),
      type: 'warning',
    })
  } catch {
    return
  }
  removing.value = row.id
  try {
    await api.del(`/api/service-contracts/${row.id}`)
    ElMessage.success(t('f4.svc.deleted'))
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    removing.value = ''
  }
}

onMounted(() => {
  loadParties()
  refresh()
})
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input
        v-model="keyword"
        :placeholder="t('f4.svc.search')"
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
      <el-select v-model="status" clearable :placeholder="t('f4.svc.status')" class="status" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`f4.cstatus.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openCreate">{{ t('f4.svc.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="items" v-loading="loading" border data-test="table" @row-dblclick="canUpdate() && openEdit($event)">
      <el-table-column prop="code" :label="t('f4.svc.code')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.svc.name')" min-width="170">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.svc.party')" min-width="160">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="partyLabel(row.partyId)">{{ partyName(row.partyId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.svc.period')" width="190">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.startAt) }} ~ {{ fmtDate(row.endAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.svc.slaLevel')" width="110">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.slaLevel">{{ row.slaLevel || t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.svc.responseMinutes')" width="110" align="right">
        <template #default="{ row }">
          <span class="erp-weak">{{ row.responseMinutes == null ? '—' : `${row.responseMinutes}${t('f4.svc.minUnit')}` }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.svc.resolveMinutes')" width="110" align="right">
        <template #default="{ row }">
          <span class="erp-weak">{{ row.resolveMinutes == null ? '—' : `${row.resolveMinutes}${t('f4.svc.minUnit')}` }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.svc.amount')" width="130" align="right">
        <template #default="{ row }">
          <span class="erp-ellipsis num" :title="String(row.amount)">{{ money(row.amount) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.svc.status')" width="100">
        <template #default="{ row }">
          <el-tag
            size="small"
            round
            effect="plain"
            :type="row.status === 'active' ? 'success' : row.status === 'terminated' ? 'danger' : 'info'"
          >
            {{ t(`f4.cstatus.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="150" align="right">
        <template #default="{ row }">
          <el-button v-if="canUpdate()" link type="primary" @click="openEdit(row)">{{ t('action.edit') }}</el-button>
          <el-button
            v-if="canDelete()"
            link
            type="danger"
            :loading="removing === row.id"
            @click="remove(row)"
          >
            {{ t('f4.svc.delete') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('f4.svc.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f4.svc.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer
    v-model="drawer"
    :title="editing ? t('f4.svc.edit') : t('f4.svc.new')"
    size="460px"
    data-test="svc-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f4.svc.code')" required>
        <el-input v-model="form.code" maxlength="64" data-test="f-code"  placeholder="留空自动生成"/>
      </el-form-item>
      <el-form-item :label="t('f4.svc.name')" required>
        <el-input v-model="form.name" maxlength="64" data-test="f-name" />
      </el-form-item>
      <el-form-item :label="t('f4.svc.party')" required>
        <el-select v-model="form.partyId" filterable style="width: 100%">
          <el-option v-for="p in parties" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f4.svc.startAt')">
        <el-date-picker v-model="form.startAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f4.svc.endAt')">
        <el-date-picker v-model="form.endAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f4.svc.slaLevel')">
        <el-input v-model="form.slaLevel" maxlength="16" />
      </el-form-item>
      <el-form-item :label="t('f4.svc.responseMinutes')">
        <el-input-number v-model="form.responseMinutes" :min="0" :max="525600" :controls="false" :placeholder="t('f4.svc.slaHint')" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f4.svc.resolveMinutes')">
        <el-input-number v-model="form.resolveMinutes" :min="0" :max="525600" :controls="false" :placeholder="t('f4.svc.slaHint')" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f4.svc.amount')">
        <el-input-number v-model="form.amount" :min="0" :precision="2" :controls="false" style="width: 100%" />
      </el-form-item>
      <el-form-item v-if="editing" :label="t('f4.svc.status')">
        <el-select v-model="form.status" style="width: 100%">
          <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`f4.cstatus.${k}`)" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
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
.num {
  font-variant-numeric: tabular-nums;
}
@media (max-width: 900px) {
  .search,
  .status {
    width: 100%;
  }
}
</style>
