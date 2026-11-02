<script setup>
/**
 * 工单：状态是后端约定的中文字面值，推进只渲染每行的 allowed。
 * SLA 剩余时间在本地按 slaDueAt 算（每分钟刷一次），超时判定以 /api/sla/overdue 为准。
 * 挂起走独立端点；若部署里没有（404）就退回 advance(to:'挂起')。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { dateInput, fmtDate, fmtDateTime, memberName, shortId } from '../format.js'

const STATUSES = ['待受理', '已派工', '处理中', '待验证', '已关闭', '挂起']
const PRIORITIES = ['low', 'normal', 'high', 'urgent']

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const status = ref('')
const priority = ref('')
const overdueOnly = ref(false)

/** id → 超时分钟数；只用于标记与筛选，不参与"是否超时"的本地判断 */
const overdueMap = ref(new Map())
const overdueError = ref('')

const parties = ref([])
const partyMap = computed(() => new Map(parties.value.map((p) => [p.id, p])))
const partyName = (id) => partyMap.value.get(id)?.name ?? (id ? shortId(id) : t('common.none'))

const contracts = ref([])
const contractMap = computed(() => new Map(contracts.value.map((c) => [c.id, c])))
const contractLabel = (id) => {
  const c = contractMap.value.get(id)
  return c ? `${c.code} ${c.name}` : ''
}

const shown = computed(() =>
  overdueOnly.value ? items.value.filter((row) => overdueMap.value.has(row.id)) : items.value,
)

const drawer = ref(false)
const busy = ref(false)
const advancing = ref('')
const form = reactive({ title: '', content: '', sn: '', priority: 'normal', partyId: '', contractId: '', reportedAt: dateInput(new Date()) })

const dispatchOpen = ref(false)
const dispatchFor = ref(null)
const dispatchForm = reactive({ engineerId: '', note: '' })

const detailOpen = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
const detailError = ref('')

/** 每分钟重算剩余时间；页面卸载时清掉，避免定时器泄漏 */
const nowMs = ref(Date.now())
let timer = 0

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('ticket:create')
const canUpdate = () => has('ticket:update')
const canDispatch = () => has('ticket:dispatch')
const canDispatchRow = (row) => row.status === '待受理' || row.status === '已派工'
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

/** 分钟 → 1d 2h / 3h 20m / 45m */
function fmtSpan(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0))
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`
  return `${m}m`
}

function slaOf(row) {
  if (row.status === '挂起') return { kind: 'paused', text: t('f4.ticket.slaPaused') }
  if (row.status === '已关闭') return { kind: 'none', text: '—' }
  if (overdueMap.value.has(row.id)) {
    return { kind: 'overdue', text: tp('f4.ticket.overdueTag', { n: fmtSpan(overdueMap.value.get(row.id)) }) }
  }
  if (!row.slaDueAt) return { kind: 'none', text: '—' }
  const diff = new Date(row.slaDueAt).getTime() - nowMs.value
  if (Number.isNaN(diff)) return { kind: 'none', text: '—' }
  if (diff <= 0) return { kind: 'overdue', text: tp('f4.ticket.overdueTag', { n: fmtSpan(Math.ceil(-diff / 60000)) }) }
  return { kind: 'remain', text: tp('f4.ticket.remain', { d: fmtSpan(Math.ceil(diff / 60000)) }) }
}

const actLabel = (action) => {
  const key = `f4.ticket.act.${action}`
  const label = t(key)
  return label === key ? action : label
}

async function loadLookups() {
  try {
    parties.value = (await api.get('/api/parties?limit=100')).items ?? []
  } catch {
    // 客户名退化显示短 id
  }
  try {
    contracts.value = (await api.get('/api/service-contracts?limit=100')).items ?? []
  } catch {
    // 没有服务合同权限时退化为只按客户建单
  }
}

async function loadOverdue() {
  overdueError.value = ''
  try {
    const data = await api.get('/api/sla/overdue')
    overdueMap.value = new Map((data.items ?? []).map((row) => [row.id, row.overdueMinutes ?? 0]))
  } catch (err) {
    overdueMap.value = new Map()
    overdueError.value = msgOf(err)
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
    if (priority.value) qs.set('priority', priority.value)
    const data = await api.get(`/api/tickets?${qs}`)
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

async function refresh() {
  cursor.value = ''
  await load(true)
  await loadOverdue()
}

function openCreate() {
  Object.assign(form, {
    title: '',
    content: '',
    sn: '',
    priority: 'normal',
    partyId: '',
    contractId: '',
    reportedAt: dateInput(new Date()),
  })
  drawer.value = true
}

async function create() {
  if (!form.title.trim()) {
    ElMessage.warning(t('common.required'))
    return
  }
  if (!form.partyId && !form.contractId) {
    ElMessage.warning(t('f4.ticket.partyOrContract'))
    return
  }
  busy.value = true
  try {
    await api.post('/api/tickets', {
      title: form.title.trim(),
      content: form.content || null,
      sn: form.sn || null,
      priority: form.priority,
      partyId: form.partyId || null,
      contractId: form.contractId || null,
      reportedAt: form.reportedAt || null,
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

async function advance(row, to) {
  advancing.value = row.id
  try {
    await api.post(`/api/tickets/${row.id}/advance`, { to, version: row.version })
    ElMessage.success(t('action.saved'))
    await refresh()
  } catch (err) {
    // 并发改了状态 / 非法跳转：后端 reason 原样给用户
    ElMessage.error(msgOf(err))
  } finally {
    advancing.value = ''
  }
}

/** 可选说明的输入框；取消返回 null，空串表示不填 */
async function promptOptional(titleKey) {
  try {
    const { value } = await ElMessageBox.prompt('', t(titleKey), {
      confirmButtonText: t('action.save'),
      cancelButtonText: t('action.cancel'),
      inputType: 'textarea',
      inputPlaceholder: t(titleKey),
    })
    return (value ?? '').trim()
  } catch {
    return null
  }
}

/**
 * 挂起 / 恢复有独立端点；404 说明这套后端只用 advance，
 * 于是挂起退回 advance(to:'挂起')，恢复退回 advance(to:'处理中')（后端 resume 的默认原状态）。
 */
async function safePost(row, path, body, fallbackTo) {
  advancing.value = row.id
  try {
    await api.post(path, body)
    ElMessage.success(t('action.saved'))
    await refresh()
  } catch (err) {
    if (err.status === 404 && fallbackTo) {
      advancing.value = ''
      await advance(row, fallbackTo)
      return
    }
    ElMessage.error(msgOf(err))
  } finally {
    advancing.value = ''
  }
}

async function pause(row) {
  const comment = await promptOptional('f4.ticket.pauseReason')
  if (comment === null) return
  await safePost(row, `/api/tickets/${row.id}/pause`, { comment: comment || undefined }, '挂起')
}

async function resume(row) {
  const comment = await promptOptional('f4.ticket.resumeReason')
  if (comment === null) return
  await safePost(row, `/api/tickets/${row.id}/resume`, { comment: comment || undefined }, '处理中')
}

function onCommand(row, to) {
  if (to === '挂起') pause(row)
  else advance(row, to)
}

function openDispatch(row) {
  dispatchFor.value = row
  dispatchForm.engineerId = row.assigneeId ?? ''
  dispatchForm.note = ''
  dispatchOpen.value = true
}

async function dispatch() {
  if (!dispatchForm.engineerId) {
    ElMessage.warning(t('f4.ticket.engineerRequired'))
    return
  }
  busy.value = true
  try {
    await api.post(`/api/tickets/${dispatchFor.value.id}/dispatch`, {
      engineerId: dispatchForm.engineerId,
      note: dispatchForm.note || null,
    })
    ElMessage.success(t('action.saved'))
    dispatchOpen.value = false
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    busy.value = false
  }
}

async function openDetail(row) {
  detail.value = row
  detailError.value = ''
  detailOpen.value = true
  detailLoading.value = true
  try {
    detail.value = await api.get(`/api/tickets/${row.id}`)
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
  timer = setInterval(() => {
    nowMs.value = Date.now()
  }, 60_000)
})

onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input
        v-model="keyword"
        :placeholder="t('f4.ticket.search')"
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
      <el-select v-model="status" clearable :placeholder="t('f4.ticket.status')" class="status" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`f4.tstatus.${k}`)" />
      </el-select>
      <el-select v-model="priority" clearable :placeholder="t('f4.ticket.priority')" class="status" @change="refresh">
        <el-option v-for="k in PRIORITIES" :key="k" :value="k" :label="t(`f4.prio.${k}`)" />
      </el-select>
      <el-checkbox v-model="overdueOnly" class="ovd" data-test="overdue-only">{{ t('f4.ticket.overdueOnly') }}</el-checkbox>
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openCreate">{{ t('f4.ticket.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />
    <el-alert v-if="overdueError" class="err" type="warning" :title="overdueError" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column prop="code" :label="t('f4.ticket.code')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.ticket.title')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.title">{{ row.title }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.ticket.party')" min-width="150">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="partyName(row.partyId)">{{ partyName(row.partyId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.ticket.status')" width="100">
        <template #default="{ row }">
          <el-tag
            size="small"
            round
            effect="plain"
            :type="row.status === '已关闭' ? 'success' : row.status === '挂起' ? 'warning' : 'primary'"
          >
            {{ t(`f4.tstatus.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.ticket.priority')" width="90">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="t(`f4.prio.${row.priority}`)">{{ t(`f4.prio.${row.priority}`) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.ticket.assignee')" width="110">
        <template #default="{ row }">
          <span v-if="row.assigneeId" class="erp-ellipsis" :title="row.assigneeId">{{ memberName(row.assigneeId) }}</span>
          <span v-else class="erp-weak">{{ t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.ticket.sla')" width="130">
        <template #default="{ row }">
          <span
            :class="['sla', slaOf(row).kind === 'overdue' ? 'sla-bad' : slaOf(row).kind === 'remain' ? 'sla-ok' : 'erp-weak']"
          >
            {{ slaOf(row).text }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.ticket.createdAt')" width="120">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="230" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ t('f4.ticket.detail') }}</el-button>
          <el-button
            v-if="canDispatch() && canDispatchRow(row)"
            link
            type="primary"
            @click="openDispatch(row)"
          >
            {{ t('f4.ticket.dispatch') }}
          </el-button>
          <el-button v-if="canUpdate() && row.canResume" link type="warning" @click="resume(row)">
            {{ t('f4.ticket.resume') }}
          </el-button>
          <el-dropdown
            v-if="canUpdate() && row.allowed?.length && !row.canResume"
            trigger="click"
            :disabled="advancing === row.id"
            @command="(to) => onCommand(row, to)"
          >
            <el-button link type="primary" :loading="advancing === row.id">
              {{ t('action.advance') }}<el-icon class="chev"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="to in row.allowed" :key="to" :command="to">
                  {{ t(`f4.tstatus.${to}`) }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('f4.ticket.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f4.ticket.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
      <span v-if="overdueOnly"> · {{ t('f4.ticket.clientFilter') }}</span>
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="drawer" :title="t('f4.ticket.editTitle')" size="460px" data-test="ticket-drawer">
    <el-form label-position="top">
      <el-form-item :label="t('f4.ticket.titleField')" required>
        <el-input v-model="form.title" maxlength="64" data-test="f-title" />
      </el-form-item>
      <el-form-item :label="t('f4.ticket.content')">
        <el-input v-model="form.content" type="textarea" :rows="3" maxlength="5000" />
      </el-form-item>
      <el-form-item :label="t('f4.ticket.party')" required>
        <el-select v-model="form.partyId" clearable filterable :placeholder="t('f4.ticket.pickParty')" style="width: 100%">
          <el-option v-for="p in parties" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f4.ticket.contract')">
        <el-select v-model="form.contractId" clearable filterable :placeholder="t('f4.ticket.pickContract')" style="width: 100%">
          <el-option v-for="c in contracts" :key="c.id" :value="c.id" :label="`${c.code} ${c.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f4.ticket.sn')">
        <el-input v-model="form.sn" maxlength="64" />
      </el-form-item>
      <el-form-item :label="t('f4.ticket.priority')">
        <el-select v-model="form.priority" style="width: 100%">
          <el-option v-for="k in PRIORITIES" :key="k" :value="k" :label="t(`f4.prio.${k}`)" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f4.ticket.reportedAt')">
        <el-date-picker v-model="form.reportedAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="create">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer v-model="dispatchOpen" :title="t('f4.ticket.dispatchTitle')" size="420px" data-test="dispatch-drawer">
    <div v-if="dispatchFor" class="drawer-head">
      <span class="code">{{ dispatchFor.code }}</span>
      <span class="erp-ellipsis" :title="dispatchFor.title">{{ dispatchFor.title }}</span>
    </div>
    <el-form label-position="top">
      <el-form-item :label="t('f4.ticket.engineer')" required>
        <el-select v-model="dispatchForm.engineerId" filterable :placeholder="t('f4.ticket.engineer')" style="width: 100%">
          <el-option v-for="m in state.members" :key="m.userId" :value="m.userId" :label="m.displayName" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f4.ticket.dispatchNote')">
        <el-input v-model="dispatchForm.note" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dispatchOpen = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" @click="dispatch">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer v-model="detailOpen" :title="t('f4.ticket.history')" size="480px" data-test="ticket-detail">
    <div v-loading="detailLoading" class="detail">
      <el-alert v-if="detailError" type="error" :title="detailError" :closable="false" show-icon />
      <template v-if="detail">
        <div class="detail-head">
          <span class="code">{{ detail.code }}</span>
          <span class="erp-ellipsis" :title="detail.title">{{ detail.title }}</span>
        </div>
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item :label="t('f4.ticket.status')">
            {{ t(`f4.tstatus.${detail.status}`) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f4.ticket.priority')">
            {{ t(`f4.prio.${detail.priority}`) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f4.ticket.party')">{{ partyName(detail.partyId) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f4.ticket.assignee')">
            {{ detail.assigneeId ? memberName(detail.assigneeId) : t('common.none') }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f4.ticket.contract')" :span="2">
            <span class="erp-ellipsis" :title="contractLabel(detail.contractId) || partyName(detail.partyId)">
              {{ contractLabel(detail.contractId) || t('common.none') }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item :label="t('f4.ticket.sla')" :span="2">
            {{ slaOf(detail).text }}
            <span v-if="detail.slaDueAt" class="erp-weak"> · {{ fmtDateTime(detail.slaDueAt) }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <div v-if="detail.content" class="detail-body erp-clamp-2" :title="detail.content">{{ detail.content }}</div>
        <el-timeline v-if="detail.events?.length">
          <el-timeline-item v-for="log in detail.events" :key="log.id" :timestamp="fmtDateTime(log.at)">
            <div class="his-line">{{ actLabel(log.action) }}</div>
            <div v-if="log.comment" class="erp-weak erp-clamp-2" :title="log.comment">{{ log.comment }}</div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else-if="!detailError && !detailLoading" :image-size="56" :description="t('f4.ticket.historyEmpty')" />
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.search {
  width: 230px;
}
.status {
  width: 130px;
}
.ovd {
  margin-left: 2px;
}
.err {
  margin-bottom: 12px;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.chev {
  margin-left: 2px;
}
.sla {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.sla-bad {
  color: var(--erp-danger);
  font-weight: 600;
}
.sla-ok {
  color: var(--erp-success);
}
.drawer-head,
.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin-bottom: 14px;
}
.detail {
  min-height: 120px;
}
.detail-body {
  margin: 12px 0;
  font-size: 13px;
  color: var(--erp-text-2);
}
.his-line {
  font-size: 13px;
  color: var(--erp-text);
}
@media (max-width: 900px) {
  .search,
  .status {
    width: 100%;
  }
  .ovd {
    margin-left: 0;
  }
}
</style>
