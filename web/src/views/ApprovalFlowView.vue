<script setup>
/**
 * 审批流程配置：列表 + 新建 / 编辑抽屉。
 *
 * steps 在库里 / 提交时是 **snake_case**（no / approver_type / approver_ref / mode / min_amount / max_amount），
 * 读接口回来是 camelCase（approverType …）—— 这里的表单统一用 snake_case，进出各转一次。
 * 金额一律当字符串交给后端（http/money.mjs 走分），前端不做浮点运算。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDate, memberName } from '../format.js'

const DOC_TYPES = ['QUOTATION', 'PURCHASE_ORDER', 'MATERIAL_ISSUE', 'CHANGE_ORDER', 'SUBCONTRACT_PROGRESS', 'AI_DRAFT']
const APPROVER_TYPES = ['role', 'user', 'manager']
const MODES = ['any', 'all']
const ROLE_CODES = ['owner', 'member']

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const docType = ref('')
/** '' = 全部；'true' / 'false' 直接交给后端 enabled 参数 */
const enabled = ref('')

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const form = reactive({ code: '', name: '', docType: 'PURCHASE_ORDER', enabled: true, steps: [] })

const has = (perm) => {
  const perms = state.perms
  if (perms.includes('*') || perms.includes(perm)) return true
  const [mod, action] = perm.split(':')
  return perms.includes(`${mod}:*`) || perms.includes(`*:${action}`)
}
const canConfig = computed(() => has('approval:config'))
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

function label(prefix, raw) {
  const key = `${prefix}.${String(raw ?? '').toLowerCase()}`
  const hit = t(key)
  return hit === key ? String(raw ?? t('common.none')) : hit
}
const docLabel = (v) => label('f1.docType', v)

function approverText(s) {
  const type = s.approverType ?? s.approver_type
  const ref = s.approverRef ?? s.approver_ref
  if (type === 'manager') return t('f1.flow.managerAuto')
  if (!ref) return t('common.none')
  return type === 'user' ? memberName(ref) : `${t('f1.atype.role')} ${ref}`
}

const stepSummary = (row) =>
  (row.steps ?? [])
    .map((s) => `#${s.no} ${t(`f1.atype.${s.approverType ?? s.approver_type}`)} ${approverText(s)} ${t(`f1.amode.${s.mode ?? 'any'}`)}`)
    .join(' → ')

/** 搜索只过滤已加载的行（后端没有 q 参数），底栏仍是游标加载更多 */
const kw = computed(() => keyword.value.trim().toLowerCase())
const shown = computed(() => {
  const k = kw.value
  if (!k) return items.value
  return items.value.filter((row) =>
    [row.code, row.name, docLabel(row.docType), stepSummary(row)].some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})

async function load(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    if (docType.value) qs.set('docType', docType.value)
    if (enabled.value) qs.set('enabled', enabled.value)
    const data = await api.get(`/api/approval/flows?${qs}`)
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

const blankStep = (no) => ({
  no,
  approver_type: 'role',
  approver_ref: '',
  mode: 'any',
  min_amount: '',
  max_amount: '',
})

function resetForm() {
  Object.assign(form, {
    code: '',
    name: '',
    docType: 'PURCHASE_ORDER',
    enabled: true,
    steps: [blankStep(1)],
  })
}

function openCreate() {
  editing.value = null
  resetForm()
  drawer.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    code: row.code ?? '',
    name: row.name ?? '',
    docType: row.docType ?? 'PURCHASE_ORDER',
    enabled: Boolean(row.enabled),
    // API 是 camelCase，表单统一 snake_case；金额原样保留字符串
    steps: (row.steps ?? []).map((s) => ({
      no: s.no,
      approver_type: s.approverType,
      approver_ref: s.approverRef ?? '',
      mode: s.mode ?? 'any',
      min_amount: s.minAmount ?? '',
      max_amount: s.maxAmount ?? '',
    })),
  })
  if (!form.steps.length) form.steps = [blankStep(1)]
  drawer.value = true
}

function addStep() {
  const max = form.steps.reduce((n, s) => Math.max(n, Number(s.no) || 0), 0)
  form.steps.push(blankStep(max + 1))
}

function removeStep(i) {
  if (form.steps.length <= 1) return
  form.steps.splice(i, 1)
}

function validateForm() {
  if (!editing.value && !form.code.trim()) return t('common.required')
  if (!form.name.trim() || !form.docType) return t('common.required')
  if (!form.steps.length) return t('f1.flow.needSteps')
  const seen = new Set()
  for (const s of form.steps) {
    const no = Number(s.no)
    if (!Number.isInteger(no) || no < 1 || seen.has(no)) return t('f1.flow.badStepNo')
    seen.add(no)
    if (s.approver_type !== 'manager' && !String(s.approver_ref ?? '').trim()) {
      return tp('f1.flow.stepMissingApprover', { n: no })
    }
  }
  return ''
}

/** 表单（snake_case）→ 提交体（同样是 snake_case，只是清洗空值） */
const stepsPayload = () =>
  form.steps.map((s) => ({
    no: Number(s.no),
    approver_type: s.approver_type,
    approver_ref: s.approver_type === 'manager' ? null : String(s.approver_ref ?? '').trim() || null,
    mode: s.mode || 'any',
    min_amount: String(s.min_amount ?? '').trim() || null,
    max_amount: String(s.max_amount ?? '').trim() || null,
  }))

async function save() {
  const bad = validateForm()
  if (bad) {
    ElMessage.warning(bad)
    return
  }
  busy.value = true
  try {
    const steps = stepsPayload()
    const base = {
      name: form.name.trim(),
      docType: form.docType,
      enabled: form.enabled,
      steps,
    }
    if (editing.value) {
      await api.patch(`/api/approval/flows/${editing.value.id}`, { ...base, version: editing.value.version })
      ElMessage.success(t('f1.flow.updated'))
    } else {
      await api.post('/api/approval/flows', { ...base, code: form.code.trim() })
      ElMessage.success(t('f1.flow.created'))
    }
    drawer.value = false
    refresh()
  } catch (err) {
    // 编码重复 409 / steps 校验 400 都从 details 里捞原因
    ElMessage.error(msgOf(err))
  } finally {
    busy.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input v-model="keyword" :placeholder="t('f1.flow.search')" clearable class="search" data-test="search">
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-select v-model="docType" clearable :placeholder="t('f1.flow.docType')" class="pick" @change="refresh">
        <el-option v-for="k in DOC_TYPES" :key="k" :value="k" :label="docLabel(k)" />
      </el-select>
      <el-select v-model="enabled" :placeholder="t('f1.flow.enabled')" class="pick" @change="refresh">
        <el-option value="" :label="t('f1.common.all')" />
        <el-option value="true" :label="t('f1.flow.enabledOn')" />
        <el-option value="false" :label="t('f1.flow.enabledOff')" />
      </el-select>
    </template>

    <template #actions>
      <el-button v-if="canConfig" type="primary" data-test="flow-new" @click="openCreate">{{ t('f1.flow.new') }}</el-button>
      <span v-else class="erp-weak">{{ t('f1.flow.noPermission') }}</span>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="(row) => canConfig && openEdit(row)">
      <el-table-column prop="code" :label="t('f1.flow.code')" width="180">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" :label="t('f1.flow.name')" min-width="170">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f1.flow.docType')" width="150">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.docType">{{ docLabel(row.docType) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f1.flow.steps')" min-width="260">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="stepSummary(row)">{{ stepSummary(row) }}</span>
          <span class="erp-weak count">{{ tp('f1.flow.stepCount', { n: (row.steps ?? []).length }) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f1.flow.enabled')" width="100">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" :type="row.enabled ? 'success' : 'info'">
            {{ row.enabled ? t('f1.flow.enabledOn') : t('f1.flow.enabledOff') }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('f1.flow.updatedAt')" width="120">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.updatedAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="90" align="right">
        <template #default="{ row }">
          <el-button v-if="canConfig" link type="primary" @click="openEdit(row)">{{ t('action.edit') }}</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="kw ? t('common.noMatch') : t('f1.flow.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f1.flow.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
      <template v-if="kw"> · {{ t('common.clientFilter') }}</template>
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer
    v-model="drawer"
    :title="editing ? t('f1.flow.editTitle') : t('f1.flow.createTitle')"
    size="640px"
    data-test="flow-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f1.flow.code')" :required="!editing">
        <el-input v-model="form.code" :disabled="!!editing" maxlength="64" :placeholder="t('f1.flow.codeHint')" data-test="f-code" />
      </el-form-item>
      <el-form-item :label="t('f1.flow.name')" required>
        <el-input v-model="form.name" maxlength="64" data-test="f-name" />
      </el-form-item>
      <el-form-item :label="t('f1.flow.docType')" required>
        <el-select v-model="form.docType" filterable allow-create default-first-option style="width: 100%" :placeholder="t('f1.flow.docTypeHint')">
          <el-option v-for="k in DOC_TYPES" :key="k" :value="k" :label="`${docLabel(k)} · ${k}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f1.flow.enabled')">
        <el-switch v-model="form.enabled" />
      </el-form-item>

      <div class="steps-head">
        <span class="steps-title">{{ t('f1.flow.stepsTitle') }}</span>
        <el-button size="small" data-test="step-add" @click="addStep">{{ t('f1.flow.addStep') }}</el-button>
      </div>

      <div v-if="!form.steps.length" class="erp-weak empty-steps">{{ t('f1.flow.emptySteps') }}</div>
      <div v-for="(s, i) in form.steps" :key="i" class="step-row" data-test="step-row">
        <div class="sf">
          <span class="sf-label">{{ t('f1.flow.no') }}</span>
          <el-input-number v-model="s.no" :min="1" :max="20" size="small" controls-position="right" class="sf-no" />
        </div>
        <div class="sf">
          <span class="sf-label">{{ t('f1.flow.approverType') }}</span>
          <el-select v-model="s.approver_type" size="small" class="sf-type" @change="s.approver_ref = ''">
            <el-option v-for="k in APPROVER_TYPES" :key="k" :value="k" :label="t(`f1.atype.${k}`)" />
          </el-select>
        </div>
        <div class="sf grow">
          <span class="sf-label">{{ t('f1.flow.approver') }}</span>
          <el-input v-if="s.approver_type === 'manager'" :model-value="t('f1.flow.managerAuto')" disabled size="small" />
          <el-select
            v-else-if="s.approver_type === 'user'"
            v-model="s.approver_ref"
            filterable
            allow-create
            default-first-option
            size="small"
            style="width: 100%"
            :placeholder="t('f1.flow.userHint')"
          >
            <el-option v-for="m in state.members" :key="m.userId" :value="m.userId" :label="m.displayName" />
          </el-select>
          <el-select
            v-else
            v-model="s.approver_ref"
            filterable
            allow-create
            default-first-option
            size="small"
            style="width: 100%"
            :placeholder="t('f1.flow.roleHint')"
          >
            <el-option v-for="r in ROLE_CODES" :key="r" :value="r" :label="r" />
          </el-select>
        </div>
        <div class="sf">
          <span class="sf-label">{{ t('f1.flow.mode') }}</span>
          <el-select v-model="s.mode" size="small" class="sf-mode">
            <el-option v-for="k in MODES" :key="k" :value="k" :label="t(`f1.amode.${k}`)" />
          </el-select>
        </div>
        <div class="sf">
          <span class="sf-label">{{ t('f1.flow.minAmount') }}</span>
          <el-input v-model="s.min_amount" size="small" class="sf-amt" :placeholder="t('f1.flow.unlimited')" />
        </div>
        <div class="sf">
          <span class="sf-label">{{ t('f1.flow.maxAmount') }}</span>
          <el-input v-model="s.max_amount" size="small" class="sf-amt" :placeholder="t('f1.flow.unlimited')" />
        </div>
        <el-button link type="danger" :disabled="form.steps.length <= 1" class="sf-del" @click="removeStep(i)">
          {{ t('f1.flow.removeStep') }}
        </el-button>
      </div>
      <div class="erp-weak steps-note">{{ t('f1.flow.stepsNote') }}</div>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.search {
  width: 230px;
}
.pick {
  width: 150px;
}
.err {
  margin-bottom: 12px;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.count {
  margin-left: 8px;
  white-space: nowrap;
}
.steps-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0 10px;
  border-top: 1px solid var(--erp-border);
  margin-top: 4px;
}
.steps-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--erp-text);
}
.empty-steps {
  padding: 8px 0;
}
.step-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px;
  border: 1px solid var(--erp-border);
  border-radius: var(--erp-radius-sm);
  background: var(--erp-surface-2);
  margin-bottom: 10px;
}
.sf {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.sf.grow {
  flex: 1 1 180px;
}
.sf-label {
  font-size: 11px;
  color: var(--erp-text-3);
}
.sf-no {
  width: 92px;
}
.sf-type {
  width: 104px;
}
.sf-mode {
  width: 120px;
}
.sf-amt {
  width: 120px;
}
.sf-del {
  margin-left: auto;
}
.steps-note {
  line-height: 1.6;
}
@media (max-width: 900px) {
  .search,
  .pick {
    width: 100%;
  }
  .sf,
  .sf.grow,
  .sf-no,
  .sf-type,
  .sf-mode,
  .sf-amt {
    width: 100%;
    flex: 1 1 100%;
  }
  .sf-del {
    margin-left: 0;
  }
}
</style>
