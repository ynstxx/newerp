<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from './api.js'
import { i18n, setLang, t } from './i18n.js'
import { logout as clearState, pickTenant, rememberedTenant, state } from './state.js'
import { memberName } from './format.js'
import AppShell from './AppShell.vue'
import LoginView from './views/LoginView.vue'
import WorkbenchView from './views/WorkbenchView.vue'
import PartyListView from './views/PartyListView.vue'
import OpportunityListView from './views/OpportunityListView.vue'
import ProjectListView from './views/ProjectListView.vue'
import QuotationListView from './views/QuotationListView.vue'
import ContractListView from './views/ContractListView.vue'
import ComingSoonView from './views/ComingSoonView.vue'
import InboxView from './views/InboxView.vue'
import ApprovalCenterView from './views/ApprovalCenterView.vue'
import ApprovalFlowView from './views/ApprovalFlowView.vue'
import NotifySettingsView from './views/NotifySettingsView.vue'
import WorkPlanView from './views/WorkPlanView.vue'
import MaterialIssueView from './views/MaterialIssueView.vue'
import ChangeOrderView from './views/ChangeOrderView.vue'
import AcceptanceView from './views/AcceptanceView.vue'
import LaborHourView from './views/LaborHourView.vue'
import PurchaseOrderView from './views/PurchaseOrderView.vue'
import GoodsReceiptView from './views/GoodsReceiptView.vue'
import SubcontractView from './views/SubcontractView.vue'
import LedgerView from './views/LedgerView.vue'
import ProfitView from './views/ProfitView.vue'
import TicketView from './views/TicketView.vue'
import ServiceContractView from './views/ServiceContractView.vue'
import IntegrationView from './views/IntegrationView.vue'
import AiChatView from './views/AiChatView.vue'
import AiDraftView from './views/AiDraftView.vue'
import SettingsView from './views/SettingsView.vue'

const booted = ref(false)
const collapsed = ref(false)
const tabs = ref([{ key: 'workbench' }])
const active = ref('workbench')
/** 刷新 = 换 key 重挂当前视图，比给每个视图写 reload 接口便宜 */
const reloadSeq = ref(0)

const viewKey = computed(() => `${state.tenant?.slug ?? '-'}:${active.value}:${reloadSeq.value}`)

async function pickAndLoad(slug) {
  pickTenant(slug)
  // 租户作用域的 /api/me 才有 perms，界面据此决定显不显示删按钮
  const me = await api.get('/api/me')
  state.perms = me.perms ?? []
  if (me.tenant) state.tenant = { ...me.tenant }
  // 通讯录：负责人/项目经理列要显示姓名而不是 uuid
  try {
    state.members = (await api.get('/api/members')).items ?? []
  } catch {
    state.members = []
  }
  // 数据字典：枚举值只从服务端取，前端不再硬编码
  try {
    const meta = await api.get('/api/meta/dicts')
    state.dicts = meta.dicts ?? {}
    state.dictPrefix = meta.labelPrefix ?? {}
  } catch {
    state.dicts = {}
  }
}

async function loadMe() {
  const me = await api.get('/api/me', { tenant: false })
  state.user = me.user
  state.tenants = me.tenants ?? []
  const remembered = rememberedTenant()
  const target = state.tenants.find((x) => x.slug === remembered) ?? state.tenants[0]
  if (target) await pickAndLoad(target.slug)
}

onMounted(async () => {
  setLang(i18n.lang === 'zh' ? 'zh' : 'en')
  try {
    await loadMe()
  } catch {
    // 401 = 还没登录，正常路径
  } finally {
    booted.value = true
  }
})

async function onLoggedIn() {
  await loadMe()
}

/** @param {string} key */
function openTab(key) {
  if (key === 'member') return
  if (!tabs.value.some((x) => x.key === key)) tabs.value = [...tabs.value, { key }]
  active.value = key
}

/** @param {string} key */
function closeTab(key) {
  const idx = tabs.value.findIndex((x) => x.key === key)
  if (idx < 0) return
  const next = tabs.value.filter((x) => x.key !== key)
  tabs.value = next
  if (active.value === key) active.value = next[Math.max(0, idx - 1)]?.key ?? 'workbench'
}

function refresh() {
  reloadSeq.value += 1
  ElMessage.success(t('top.refreshed'))
}

/** @param {string} slug */
async function switchTenant(slug) {
  try {
    await pickAndLoad(slug)
    // 换公司等于换数据集：页签回到工作台，避免看到上一家的残留
    tabs.value = [{ key: 'workbench' }]
    active.value = 'workbench'
    reloadSeq.value += 1
  } catch (err) {
    ElMessage.error(err.message)
  }
}

async function signOut() {
  try {
    await api.post('/api/auth/logout', {}, { tenant: false })
  } finally {
    clearState()
    tabs.value = [{ key: 'workbench' }]
    active.value = 'workbench'
  }
}

/** @param {string} kw */
function onSearch(kw) {
  if (!String(kw ?? '').trim()) return
  ElMessage.info(t('top.searchTodo'))
}
</script>

<template>
  <div v-if="!booted" class="boot">
    <el-skeleton animated :rows="3" class="boot-skel" />
  </div>

  <LoginView v-else-if="!state.user" @logged-in="onLoggedIn" />

  <AppShell
    v-else
    :collapsed="collapsed"
    :tabs="tabs"
    :active="active"
    @toggle="collapsed = !collapsed"
    @refresh="refresh"
    @open="openTab"
    @close="closeTab"
    @logout="signOut"
    @switch-tenant="switchTenant"
    @toggle-lang="setLang(i18n.lang === 'zh' ? 'en' : 'zh')"
    @search="onSearch"
  >
    <WorkbenchView v-if="active === 'workbench'" :key="viewKey" @open="openTab" />
    <PartyListView v-else-if="active === 'party'" :key="viewKey" />
    <OpportunityListView v-else-if="active === 'opportunity'" :key="viewKey" />
    <ProjectListView v-else-if="active === 'project'" :key="viewKey" />
    <QuotationListView v-else-if="active === 'quotation'" :key="viewKey" />
    <ContractListView v-else-if="active === 'contract'" :key="viewKey" />
    <!-- 仍是占位的只剩「成员」（菜单里置灰，走不到这里，留作兜底） -->
    <InboxView v-else-if="active === 'inbox'" :key="viewKey" />
    <ApprovalCenterView v-else-if="active === 'approvals'" :key="viewKey" />
    <ApprovalFlowView v-else-if="active === 'approvalFlows'" :key="viewKey" />
    <NotifySettingsView v-else-if="active === 'notifySettings'" :key="viewKey" />
    <WorkPlanView v-else-if="active === 'workPlans'" :key="viewKey" />
    <MaterialIssueView v-else-if="active === 'materialIssues'" :key="viewKey" />
    <ChangeOrderView v-else-if="active === 'changeOrders'" :key="viewKey" />
    <AcceptanceView v-else-if="active === 'acceptances'" :key="viewKey" />
    <LaborHourView v-else-if="active === 'laborHours'" :key="viewKey" />
    <PurchaseOrderView v-else-if="active === 'purchaseOrders'" :key="viewKey" />
    <GoodsReceiptView v-else-if="active === 'goodsReceipts'" :key="viewKey" />
    <SubcontractView v-else-if="active === 'subcontracts'" :key="viewKey" />
    <LedgerView v-else-if="active === 'ledgers'" :key="viewKey" />
    <ProfitView v-else-if="active === 'profit'" :key="viewKey" />
    <TicketView v-else-if="active === 'tickets'" :key="viewKey" />
    <ServiceContractView v-else-if="active === 'serviceContracts'" :key="viewKey" />
    <IntegrationView v-else-if="active === 'integrations'" :key="viewKey" />
    <AiChatView v-else-if="active === 'aiChat'" :key="viewKey" />
    <AiDraftView v-else-if="active === 'aiDrafts'" :key="viewKey" />
    <SettingsView v-else-if="active === 'settings'" :key="viewKey" />
    <ComingSoonView v-else :key="viewKey" :name="active" @open="openTab" />
  </AppShell>
</template>

<style scoped>
.boot {
  height: 100vh;
  display: grid;
  place-items: center;
  background: var(--erp-bg);
}
.boot-skel {
  width: min(420px, 80vw);
}
</style>
