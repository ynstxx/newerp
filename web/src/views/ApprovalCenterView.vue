<script setup>
/**
 * 审批中心：我的待办 + 我发起的。
 *
 * - 待办：GET /api/approvals/my-tasks → {items}，每行带 allowed；
 *   同意 / 驳回只按 allowed 里有没有 approved / rejected 渲染，不在前端抄状态机。
 * - 我发起的：契约写的 GET /api/approvals?mine=1 后端尚未注册，这里**探测式**调用：
 *   失败就把原因摊开（可重试），不伪造数据、也不白屏；接口就绪后不用改页面。
 * - 抽屉：事件流（/api/approvals/:id/events）+ 审批链路。
 *   链路优先用行上带的 steps（快照），否则试单据详情接口，再退回按 docType 匹配当前启用的流程定义，
 *   并明确标注来源 —— 不把「当前流程」冒充「提交时的快照」。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDateTime, memberName, money, shortId } from '../format.js'

const tab = ref('todo')
const keyword = ref('')

const todo = ref([])
const todoLoading = ref(false)
const todoError = ref('')

const mine = ref([])
const mineLoading = ref(false)
const mineError = ref('')
const mineProbed = ref(false)

const drawerOpen = ref(false)
const current = ref(null)
const events = ref([])
const eventsLoading = ref(false)
const eventsError = ref('')
const chain = ref([])
const chainLoading = ref(false)
const chainError = ref('')
/** 'snapshot' | 'flow' | '' —— 链路来源，界面上要说清楚 */
const chainSource = ref('')

const decideOpen = ref(false)
const decideRow = ref(null)
const decideAction = ref('approve')
const decideComment = ref('')
const decideBusy = ref(false)

/** 与 auth/perm.mjs 的 hasPerm 同规则：精确 / `*` / `<模块>:*` / `*:<动作>` */
const has = (perm) => {
  const perms = state.perms
  if (perms.includes('*') || perms.includes(perm)) return true
  const [mod, action] = perm.split(':')
  return perms.includes(`${mod}:*`) || perms.includes(`*:${action}`)
}
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

/** 缺 key 时 t() 原样返回 key —— 退回后端原始值，比显示 f1.docType.xxx 强 */
function label(prefix, raw) {
  const key = `${prefix}.${String(raw ?? '').toLowerCase()}`
  const hit = t(key)
  return hit === key ? String(raw ?? t('common.none')) : hit
}
const docLabel = (v) => label('f1.docType', v)
const eventLabel = (v) => label('f1.aevent', v)
const statusLabel = (v) => label('f1.astatus', v)

const tagType = (status) =>
  status === 'approved' ? 'success' : status === 'rejected' || status === 'failed' ? 'danger' : status === 'withdrawn' ? 'info' : 'warning'

/** 同意 / 驳回按钮只认 allowed */
const canApprove = (row) => row.status === 'pending' && (row.allowed ?? []).includes('approved')
const canReject = (row) => row.status === 'pending' && (row.allowed ?? []).includes('rejected')
const canWithdraw = (row) => (row.allowed ?? []).includes('withdrawn')

const kw = computed(() => keyword.value.trim().toLowerCase())
const match = (row) => {
  const k = kw.value
  if (!k) return true
  return [docLabel(row.docType), row.docId, memberName(row.submitterId)]
    .some((v) => String(v ?? '').toLowerCase().includes(k))
}
const todoShown = computed(() => todo.value.filter(match))
const mineShown = computed(() => mine.value.filter(match))
const activeStep = computed(() => Math.max(0, Number(current.value?.currentStep ?? 1) - 1))

const stepTitle = (s) => tp('f1.ac.stepN', { n: s.no })
const approverText = (s) => {
  const type = s.approverType
  if (type === 'manager') return t('f1.flow.managerAuto')
  const ref = s.approverRef
  if (!ref) return t('common.none')
  if (type === 'user') return memberName(ref)
  return `${t('f1.atype.role')} ${ref}`
}
const bandText = (s) => {
  if (!s.minAmount && !s.maxAmount) return t('f1.flow.unlimited')
  return `${s.minAmount ? money(s.minAmount) : money(0)} ~ ${s.maxAmount ? money(s.maxAmount) : '∞'}`
}

async function loadTodo() {
  todoLoading.value = true
  todoError.value = ''
  try {
    const data = await api.get('/api/approvals/my-tasks')
    todo.value = data.items ?? []
  } catch (err) {
    todoError.value = msgOf(err)
    todo.value = []
    ElMessage.error(todoError.value)
  } finally {
    todoLoading.value = false
  }
}

async function loadMine() {
  mineLoading.value = true
  mineError.value = ''
  mineProbed.value = true
  try {
    const data = await api.get('/api/approvals?mine=1')
    mine.value = data.items ?? []
  } catch (err) {
    mine.value = []
    mineError.value = msgOf(err)
  } finally {
    mineLoading.value = false
  }
}

function onTabChange(name) {
  if (name === 'mine' && !mineProbed.value) loadMine()
}

function ask(row, action) {
  decideRow.value = row
  decideAction.value = action
  decideComment.value = ''
  decideOpen.value = true
}

async function submitDecide() {
  const action = decideAction.value
  const comment = decideComment.value.trim()
  if (action === 'reject' && !comment) {
    ElMessage.warning(t('f1.ac.rejectNeedComment'))
    return
  }
  decideBusy.value = true
  try {
    await api.post(`/api/approvals/tasks/${decideRow.value.id}/decide`, {
      action,
      ...(comment ? { comment } : {}),
    })
    ElMessage.success(t('f1.ac.decided'))
    decideOpen.value = false
    await loadTodo()
    if (mineProbed.value) loadMine()
  } catch (err) {
    // 钩子失败（如领料库存不足）也是 409/业务 reason，原样给用户看
    ElMessage.error(msgOf(err))
  } finally {
    decideBusy.value = false
  }
}

async function withdraw(row) {
  try {
    await ElMessageBox.confirm(t('f1.ac.withdrawConfirm'), t('f1.ac.withdraw'), { type: 'warning' })
  } catch {
    return
  }
  try {
    await api.post(`/api/approvals/${row.id}/withdraw`)
    ElMessage.success(t('f1.ac.withdrawn'))
    loadMine()
  } catch (err) {
    ElMessage.error(msgOf(err))
  }
}

/** 单据详情接口尚未注册（routes-approval 只有 events）→ 静默失败再回落流程定义 */
async function loadChain(row, instanceId) {
  chainLoading.value = true
  chainError.value = ''
  chain.value = []
  chainSource.value = ''
  try {
    if (row.steps?.length) {
      chain.value = row.steps
      chainSource.value = 'snapshot'
      return
    }
    const inst = await api.get(`/api/approvals/${instanceId}`).catch(() => null)
    if (inst?.steps?.length) {
      chain.value = inst.steps
      chainSource.value = 'snapshot'
      return
    }
    const data = await api.get(`/api/approval/flows?docType=${encodeURIComponent(row.docType ?? '')}&limit=100`)
    const rows = data.items ?? []
    const flow = rows.find((f) => f.enabled) ?? rows[0] ?? null
    if (!flow) {
      chainError.value = t('f1.ac.chainEmpty')
      return
    }
    chain.value = flow.steps ?? []
    chainSource.value = 'flow'
  } catch (err) {
    chainError.value = msgOf(err)
  } finally {
    chainLoading.value = false
  }
}

async function openDetail(row) {
  current.value = row
  drawerOpen.value = true
  events.value = []
  eventsError.value = ''
  chain.value = []
  chainError.value = ''
  chainSource.value = ''
  const instanceId = row.instanceId ?? row.id
  eventsLoading.value = true
  try {
    const data = await api.get(`/api/approvals/${instanceId}/events`)
    events.value = data.items ?? []
  } catch (err) {
    eventsError.value = msgOf(err)
    ElMessage.error(eventsError.value)
  } finally {
    eventsLoading.value = false
  }
  loadChain(row, instanceId)
}

onMounted(loadTodo)
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input
        v-model="keyword"
        :placeholder="t('f1.ac.search')"
        clearable
        class="search"
        data-test="search"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
    </template>

    <template #actions>
      <el-tag v-if="todo.length" size="small" round effect="plain" type="warning">
        {{ tp('f1.ac.todoBadge', { n: todo.length }) }}
      </el-tag>
    </template>

    <el-tabs v-model="tab" class="tabs" data-test="ac-tabs" @tab-change="onTabChange">
      <el-tab-pane :label="t('f1.ac.tabTodo')" name="todo">
        <el-alert v-if="todoError" class="err" type="error" :title="todoError" :closable="false" show-icon />
        <el-table
          :data="todoShown"
          v-loading="todoLoading"
          border
          data-test="table-todo"
          @row-dblclick="openDetail"
        >
          <el-table-column :label="t('f1.ac.doc')" min-width="210">
            <template #default="{ row }">
              <div class="doc">
                <span class="erp-ellipsis" :title="`${row.docType} ${row.docId}`">{{ docLabel(row.docType) }}</span>
                <span class="code erp-ellipsis" :title="row.docId">{{ shortId(row.docId) }}</span>
                <el-tag v-if="row.claimable" size="small" round effect="plain" type="warning">
                  {{ t('f1.ac.claimable') }}
                </el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.ac.amount')" width="140" align="right">
            <template #default="{ row }">
              <span class="erp-ellipsis" :title="String(row.amount)">{{ money(row.amount) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.ac.step')" width="100" align="center">
            <template #default="{ row }">{{ tp('f1.ac.stepN', { n: row.stepNo }) }}</template>
          </el-table-column>
          <el-table-column :label="t('f1.ac.submitter')" width="120">
            <template #default="{ row }">
              <span class="erp-ellipsis" :title="row.submitterId">{{ memberName(row.submitterId) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.ac.submittedAt')" width="130">
            <template #default="{ row }">
              <span class="erp-weak">{{ fmtDateTime(row.submittedAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.ac.status')" width="110">
            <template #default="{ row }">
              <el-tag size="small" round effect="plain" :type="tagType(row.status)">{{ statusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="''" width="220" align="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">{{ t('f1.common.detail') }}</el-button>
              <el-button v-if="canApprove(row)" link type="success" data-test="approve" @click="ask(row, 'approve')">
                {{ t('f1.ac.approve') }}
              </el-button>
              <el-button v-if="canReject(row)" link type="danger" data-test="reject" @click="ask(row, 'reject')">
                {{ t('f1.ac.reject') }}
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :image-size="64" :description="kw ? t('common.noMatch') : t('f1.ac.emptyTodo')" />
          </template>
        </el-table>
      </el-tab-pane>

      <el-tab-pane :label="t('f1.ac.tabMine')" name="mine">
        <el-alert
          v-if="mineError"
          class="err"
          type="warning"
          :title="t('f1.ac.mineUnavailable')"
          :closable="false"
          show-icon
        >
          <div class="mine-hint">
            <div>{{ t('f1.ac.mineUnavailableHint') }}</div>
            <div class="erp-weak mono">{{ mineError }}</div>
          </div>
        </el-alert>
        <el-table :data="mineShown" v-loading="mineLoading" border data-test="table-mine">
          <el-table-column :label="t('f1.ac.doc')" min-width="210">
            <template #default="{ row }">
              <div class="doc">
                <span class="erp-ellipsis" :title="`${row.docType} ${row.docId}`">{{ docLabel(row.docType) }}</span>
                <span class="code erp-ellipsis" :title="row.docId">{{ shortId(row.docId) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.ac.amount')" width="140" align="right">
            <template #default="{ row }">{{ money(row.amount) }}</template>
          </el-table-column>
          <el-table-column :label="t('f1.ac.step')" width="110" align="center">
            <template #default="{ row }">
              <span v-if="row.currentStep">{{ tp('f1.ac.stepN', { n: row.currentStep }) }}</span>
              <span v-else class="erp-weak">{{ t('common.none') }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.ac.submittedAt')" width="130">
            <template #default="{ row }">
              <span class="erp-weak">{{ fmtDateTime(row.submittedAt) }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f1.ac.status')" width="110">
            <template #default="{ row }">
              <el-tag size="small" round effect="plain" :type="tagType(row.status)">{{ statusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column :label="''" width="180" align="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="openDetail(row)">{{ t('f1.common.detail') }}</el-button>
              <el-button v-if="canWithdraw(row)" link type="danger" @click="withdraw(row)">
                {{ t('f1.ac.withdraw') }}
              </el-button>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :image-size="64" :description="kw ? t('common.noMatch') : t('f1.ac.emptyMine')" />
          </template>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <template #hint>
      {{ tab === 'todo' ? t('f1.ac.hintTodo') : t('f1.ac.hintMine') }} ·
      {{ tp('page.loaded', { n: tab === 'todo' ? todo.length : mine.length }) }}
      <template v-if="kw"> · {{ t('common.clientFilter') }}</template>
    </template>

    <template #pager>
      <el-button v-if="tab === 'mine' && mineError" @click="loadMine">{{ t('f1.ac.mineRetry') }}</el-button>
      <el-button :loading="tab === 'todo' ? todoLoading : mineLoading" @click="tab === 'todo' ? loadTodo() : loadMine()">
        {{ t('f1.common.refresh') }}
      </el-button>
    </template>
  </PageTemplate>

  <el-drawer v-model="drawerOpen" :title="t('f1.ac.detailTitle')" size="520px" data-test="ac-drawer">
    <div class="detail">
      <div v-if="current" class="detail-head">
        <span class="doc-title erp-ellipsis" :title="`${current.docType} ${current.docId}`">
          {{ docLabel(current.docType) }}
        </span>
        <el-tag size="small" round effect="plain" :type="tagType(current.status)">{{ statusLabel(current.status) }}</el-tag>
        <span class="code monitor">{{ shortId(current.docId) }}</span>
        <span class="erp-weak">{{ money(current.amount) }}</span>
      </div>

      <h4 class="sec">{{ t('f1.ac.chain') }}</h4>
      <div v-loading="chainLoading" class="chain">
        <el-alert v-if="chainError" type="warning" :title="chainError" :closable="false" show-icon />
        <el-steps v-else-if="chain.length" direction="vertical" :active="activeStep" space="70px">
          <el-step v-for="s in chain" :key="s.no" :title="stepTitle(s)">
            <template #description>
              <div class="step-desc">
                {{ approverText(s) }} · {{ t(`f1.amode.${s.mode ?? 'any'}`) }} · {{ bandText(s) }}
              </div>
            </template>
          </el-step>
        </el-steps>
        <div v-else-if="!chainLoading" class="erp-weak">{{ t('f1.ac.chainEmpty') }}</div>
        <div v-if="chainSource === 'flow' && chain.length" class="erp-weak chain-src">
          {{ t('f1.ac.chainFromFlow') }}
        </div>
      </div>

      <h4 class="sec">{{ t('f1.ac.events') }}</h4>
      <div v-loading="eventsLoading" class="events">
        <el-alert v-if="eventsError" type="error" :title="eventsError" :closable="false" show-icon />
        <el-timeline v-else-if="events.length">
          <el-timeline-item
            v-for="e in events"
            :key="e.id"
            :timestamp="fmtDateTime(e.at)"
            :type="e.action === 'approve' ? 'success' : e.action === 'reject' || e.action === 'failed' ? 'danger' : 'primary'"
          >
            <div class="ev-line">
              <span class="ev-action">{{ eventLabel(e.action) }}</span>
              <span class="erp-weak erp-ellipsis" :title="e.actorId">{{ memberName(e.actorId) }}</span>
            </div>
            <div v-if="e.comment" class="erp-weak ev-note erp-clamp-2" :title="e.comment">{{ e.comment }}</div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else-if="!eventsError && !eventsLoading" :image-size="56" :description="t('f1.ac.noEvents')" />
      </div>
    </div>
  </el-drawer>

  <el-dialog
    v-model="decideOpen"
    :title="decideAction === 'approve' ? t('f1.ac.approveTitle') : t('f1.ac.rejectTitle')"
    width="420px"
    data-test="ac-decide"
  >
    <div v-if="decideRow" class="decide-head">
      <span class="erp-ellipsis" :title="`${decideRow.docType} ${decideRow.docId}`">
        {{ docLabel(decideRow.docType) }} · {{ shortId(decideRow.docId) }}
      </span>
      <span class="erp-weak">{{ money(decideRow.amount) }}</span>
    </div>
    <el-form label-position="top">
      <el-form-item :label="t('f1.ac.comment')" :required="decideAction === 'reject'">
        <el-input
          v-model="decideComment"
          type="textarea"
          :rows="3"
          maxlength="500"
          show-word-limit
          :placeholder="t('f1.ac.commentPh')"
          data-test="decide-comment"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="decideOpen = false">{{ t('action.cancel') }}</el-button>
      <el-button
        :type="decideAction === 'approve' ? 'primary' : 'danger'"
        :loading="decideBusy"
        data-test="decide-submit"
        @click="submitDecide"
      >
        {{ decideAction === 'approve' ? t('f1.ac.approve') : t('f1.ac.reject') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.search {
  width: 240px;
}
.tabs {
  margin-top: -6px;
}
.err {
  margin-bottom: 12px;
}
.mine-hint {
  margin-top: 4px;
  line-height: 1.6;
}
.doc {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.code,
.monitor {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.detail {
  min-height: 200px;
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}
.doc-title {
  font-weight: 600;
  color: var(--erp-text);
}
.sec {
  font-size: 13px;
  font-weight: 600;
  color: var(--erp-text);
  margin: var(--erp-gap) 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--erp-border);
}
.chain {
  min-height: 40px;
}
.chain-src {
  margin-top: 8px;
  line-height: 1.6;
}
.step-desc {
  font-size: 12px;
  color: var(--erp-text-2);
}
.events {
  min-height: 60px;
}
.ev-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.ev-action {
  font-weight: 600;
  color: var(--erp-text);
  font-size: 13px;
}
.ev-note {
  margin-top: 2px;
}
.decide-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  min-width: 0;
}
@media (max-width: 900px) {
  .search {
    width: 100%;
  }
}
</style>
