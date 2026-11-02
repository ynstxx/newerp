<script setup>
/**
 * 应收 / 应付台账：两个 Tab 共用一套列表，余额单独走 /balance。
 * 收付款写 /api/payments；超额核销由后端 409，drawer 里保留 details.reason。
 * 台账金额正数=未收/未付，负数=收款/付款核销后的余额变动。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDate, money, shortId } from '../format.js'

const METHODS = ['bank', 'cash', 'cheque', 'other']

const tab = ref('ar')
const entries = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')

const balance = ref(0)
const balanceLoading = ref(false)
const balanceError = ref('')

const partyId = ref('')
const parties = ref([])
const projects = ref([])

const payOpen = ref(false)
const payBusy = ref(false)
const payError = ref('')
const form = reactive({ kind: 'ar', partyId: '', projectId: '', amount: 0, method: 'bank', paidAt: null, note: '' })

const payments = ref([])
const paymentsCursor = ref('')
const paymentsLoading = ref(false)
const paymentsError = ref('')
const payLoadingMore = ref(false)

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canPay = () => has('payment:create')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

const activeParties = computed(() =>
  parties.value.filter((p) => p.partyType === 'both' || p.partyType === (tab.value === 'ar' ? 'customer' : 'supplier')),
)
const partyMap = computed(() => new Map(parties.value.map((p) => [p.id, p])))
const partyLabel = (id) => {
  const p = partyMap.value.get(id)
  return p ? `${p.code} ${p.name}` : ''
}
const partyName = (id) => partyMap.value.get(id)?.name ?? (id ? shortId(id) : t('common.none'))

const projectMap = computed(() => new Map(projects.value.map((p) => [p.id, p])))
const projectCode = (id) => projectMap.value.get(id)?.code ?? (id ? shortId(id) : t('common.none'))

const balanceKey = computed(() => (tab.value === 'ar' ? 'f3.ledger.balanceAr' : 'f3.ledger.balanceAp'))
const payLabelKey = computed(() => (tab.value === 'ar' ? 'f3.ledger.receive' : 'f3.ledger.pay'))
const ledgerPath = computed(() => (tab.value === 'ar' ? '/api/ar-ledger' : '/api/ap-ledger'))
const balancePath = computed(() => (tab.value === 'ar' ? '/api/ar-ledger/balance' : '/api/ap-ledger/balance'))

async function loadLookups() {
  try {
    const data = await api.get('/api/parties?limit=100')
    parties.value = data.items ?? []
  } catch {
    // 往来单位名退化显示 id 前缀
  }
  try {
    const data = await api.get('/api/projects?limit=100')
    projects.value = data.items ?? []
  } catch {
    // 项目编码退化显示 id 前缀
  }
}

async function loadEntries(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    if (partyId.value) qs.set('partyId', partyId.value)
    const data = await api.get(`${ledgerPath.value}?${qs}`)
    entries.value = reset ? data.items : [...entries.value, ...data.items]
    cursor.value = data.nextCursor ?? ''
  } catch (err) {
    error.value = msgOf(err)
    if (reset) entries.value = []
    ElMessage.error(error.value)
  } finally {
    loading.value = false
  }
}

async function loadBalance() {
  balanceLoading.value = true
  balanceError.value = ''
  try {
    const qs = new URLSearchParams()
    if (partyId.value) qs.set('partyId', partyId.value)
    const data = await api.get(`${balancePath.value}?${qs}`)
    balance.value = Number(data.balance ?? 0)
  } catch (err) {
    balanceError.value = msgOf(err)
    ElMessage.error(balanceError.value)
  } finally {
    balanceLoading.value = false
  }
}

async function loadPayments(reset = false) {
  if (reset) {
    paymentsLoading.value = true
    paymentsCursor.value = ''
  } else {
    payLoadingMore.value = true
  }
  paymentsError.value = ''
  try {
    const qs = new URLSearchParams({ kind: tab.value, limit: '20' })
    if (!reset && paymentsCursor.value) qs.set('cursor', paymentsCursor.value)
    if (partyId.value) qs.set('partyId', partyId.value)
    const data = await api.get(`/api/payments?${qs}`)
    payments.value = reset ? data.items : [...payments.value, ...data.items]
    paymentsCursor.value = data.nextCursor ?? ''
  } catch (err) {
    paymentsError.value = msgOf(err)
    ElMessage.error(paymentsError.value)
  } finally {
    paymentsLoading.value = false
    payLoadingMore.value = false
  }
}

function refreshAll() {
  cursor.value = ''
  paymentsCursor.value = ''
  loadEntries(true)
  loadBalance()
  if (payOpen.value) loadPayments(true)
}

function onTabChange(name) {
  tab.value = name
  partyId.value = ''
  entries.value = []
  payments.value = []
  payOpen.value = false
  refreshAll()
}

function openPay() {
  Object.assign(form, {
    kind: tab.value,
    partyId: partyId.value || '',
    projectId: '',
    amount: 0,
    method: 'bank',
    paidAt: null,
    note: '',
  })
  payError.value = ''
  payOpen.value = true
  loadPayments(true)
}

async function submitPayment() {
  if (!form.partyId || !(Number(form.amount) > 0)) {
    ElMessage.warning(t('common.required'))
    return
  }
  payBusy.value = true
  payError.value = ''
  try {
    const payload = {
      kind: tab.value,
      partyId: form.partyId,
      amount: Number(form.amount),
      method: form.method,
    }
    if (form.projectId) payload.projectId = form.projectId
    if (form.paidAt) payload.paidAt = form.paidAt
    if (form.note) payload.note = form.note
    await api.post('/api/payments', payload)
    ElMessage.success(t('action.saved'))
    payOpen.value = false
    refreshAll()
  } catch (err) {
    // 超额核销是 409，后端带了未结余额；原样放在抽屉里，不吞成一句“出错了”
    payError.value = msgOf(err)
    ElMessage.error(payError.value)
  } finally {
    payBusy.value = false
  }
}

onMounted(() => {
  loadLookups()
  refreshAll()
})
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-select
        v-model="partyId"
        clearable
        filterable
        :placeholder="t('f3.ledger.party')"
        class="party"
        data-test="party-filter"
        @change="refreshAll"
      >
        <el-option v-for="p in activeParties" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
      </el-select>
      <el-button :icon="Refresh" :loading="loading || balanceLoading" @click="refreshAll">
        {{ t('f3.ledger.refresh') }}
      </el-button>
    </template>

    <template #actions>
      <el-button v-if="canPay()" type="primary" data-test="pay" @click="openPay">{{ t(payLabelKey) }}</el-button>
    </template>

    <el-tabs v-model="tab" class="kind-tabs" @tab-change="onTabChange">
      <el-tab-pane :label="t('f3.ledger.ar')" name="ar" />
      <el-tab-pane :label="t('f3.ledger.ap')" name="ap" />
    </el-tabs>

    <div class="balance-card">
      <div class="balance-main">
        <span class="erp-weak">{{ t(balanceKey) }}</span>
        <span v-loading="balanceLoading" class="balance">{{ money(balance) }}</span>
      </div>
      <span class="erp-weak">{{ t('f3.ledger.outstandingHint') }}</span>
    </div>

    <el-alert v-if="balanceError" class="err" type="warning" :title="balanceError" :closable="false" show-icon />
    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="entries" v-loading="loading" border data-test="table">
      <el-table-column :label="t('f3.ledger.entryType')" width="130">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" :type="Number(row.amount) < 0 ? 'success' : 'primary'">
            {{ t(`f3.entry.${row.entryType}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.ledger.party')" min-width="170">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="partyLabel(row.partyId) || partyName(row.partyId)">
            {{ partyName(row.partyId) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.ledger.project')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.ledger.amount')" width="150" align="right">
        <template #default="{ row }">
          <span class="amount" :class="{ credit: Number(row.amount) < 0 }" :title="String(row.amount)">
            {{ money(row.amount) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.ledger.ref')" width="140">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.refType || ''">{{ row.refType ? t(`f3.ref.${row.refType}`) : t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.ledger.at')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.at) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f3.ledger.note')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.note || ''">{{ row.note || t('common.none') }}</span>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty
          :image-size="64"
          :description="tab === 'ar' ? t('f3.ledger.emptyAr') : t('f3.ledger.emptyAp')"
        />
      </template>
    </el-table>

    <template #hint>
      {{ tab === 'ar' ? t('f3.ledger.hintAr') : t('f3.ledger.hintAp') }} · {{ tp('page.loaded', { n: entries.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="loadEntries()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="entries.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="payOpen" :title="t(payLabelKey)" size="560px" data-test="pay-drawer">
    <el-alert v-if="payError" class="err" type="error" :title="payError" :closable="false" show-icon />

    <el-form label-position="top">
      <el-form-item :label="t('f3.ledger.kind')">
        <el-tag size="small" round effect="plain">{{ t(tab === 'ar' ? 'f3.ledger.ar' : 'f3.ledger.ap') }}</el-tag>
      </el-form-item>
      <el-form-item :label="t('f3.ledger.party')" required>
        <el-select v-model="form.partyId" filterable :placeholder="t('f3.ledger.partyPick')" style="width: 100%">
          <el-option v-for="p in activeParties" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f3.ledger.project')">
        <el-select v-model="form.projectId" filterable clearable :placeholder="t('f3.ledger.projectPick')" style="width: 100%">
          <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f3.ledger.amount')" required>
        <el-input-number v-model="form.amount" :min="0.01" :precision="2" :step="1000" controls-position="right" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f3.ledger.method')">
        <el-select v-model="form.method" style="width: 100%">
          <el-option v-for="m in METHODS" :key="m" :value="m" :label="t(`f3.method.${m}`)" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f3.ledger.paidAt')">
        <el-date-picker v-model="form.paidAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f3.ledger.note')">
        <el-input v-model="form.note" type="textarea" :rows="2" maxlength="500" />
      </el-form-item>
      <div class="right">
        <el-button @click="payOpen = false">{{ t('action.cancel') }}</el-button>
        <el-button type="primary" :loading="payBusy" data-test="pay-save" @click="submitPayment">
          {{ t('action.save') }}
        </el-button>
      </div>
    </el-form>

    <div class="sec-head">
      <span class="erp-card-title">{{ t('f3.ledger.paymentTitle') }}</span>
    </div>
    <el-alert v-if="paymentsError" class="err" type="error" :title="paymentsError" :closable="false" show-icon />
    <el-table :data="payments" v-loading="paymentsLoading" border size="small">
      <el-table-column :label="t('f3.ledger.method')" width="100">
        <template #default="{ row }">{{ t(`f3.method.${row.method}`) }}</template>
      </el-table-column>
      <el-table-column :label="t('f3.ledger.amount')" width="130" align="right">
        <template #default="{ row }">{{ money(row.amount) }}</template>
      </el-table-column>
      <el-table-column :label="t('f3.ledger.paidAt')" width="120">
        <template #default="{ row }"><span class="erp-weak">{{ fmtDate(row.paidAt) }}</span></template>
      </el-table-column>
      <el-table-column :label="t('f3.ledger.note')" min-width="150">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.note || ''">{{ row.note || t('common.none') }}</span>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="44" :description="t('f3.ledger.paymentEmpty')" />
      </template>
    </el-table>
    <div v-if="paymentsCursor" class="right more">
      <el-button size="small" :loading="payLoadingMore" @click="loadPayments()">{{ t('action.loadMore') }}</el-button>
    </div>
  </el-drawer>
</template>

<style scoped>
.party {
  width: 240px;
}
.kind-tabs {
  margin-top: -8px;
}
.balance-card {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 16px;
  margin-bottom: 12px;
  border: 1px solid var(--erp-border);
  border-radius: var(--erp-radius-sm);
  background: var(--erp-surface-2);
}
.balance-main {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.balance {
  font-size: 22px;
  font-weight: 600;
  color: var(--erp-text);
}
.err {
  margin-bottom: 12px;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.amount {
  font-variant-numeric: tabular-nums;
}
.amount.credit {
  color: var(--erp-success);
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 18px 0 8px;
}
.right {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.more {
  margin-top: 8px;
}
@media (max-width: 900px) {
  .party {
    width: 100%;
  }
  .balance-card {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
