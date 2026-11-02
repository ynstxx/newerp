<script setup>
/**
 * 施工计划 + 任务：计划列表按项目/关键字过滤，行展开时按需拉
 * `GET /api/work-tasks?planId=`（后端 getPlan 也带 tasks，但列表页不逐行拉详情）。
 * 任务推进只渲染后端 allowed；进度单独走 `POST /api/progress-logs`，
 * 推进到 done 时后端自己把 progress 置 100，前端不预判。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { dateInput, fmtDate, memberName, shortId } from '../format.js'

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const projectId = ref('')

const projects = ref([])
const projectMap = computed(() => new Map(projects.value.map((p) => [p.id, p])))
const projectCode = (id) => projectMap.value.get(id)?.code ?? (id ? shortId(id) : t('common.none'))

/** 展开行的任务：planId → { loading, error, items }，点开才拉 */
const taskState = reactive({})

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const advancing = ref('')
const form = reactive({ projectId: '', code: '', name: '', planStart: null, planEnd: null, note: '' })

const reportOpen = ref(false)
const reportFor = ref(null)
const reporting = ref(false)
const reportForm = reactive({ progress: 0, content: '' })

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('work:create')
const canUpdate = () => has('work:update')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

async function loadProjects() {
  try {
    const data = await api.get('/api/projects?limit=100')
    projects.value = data.items ?? []
  } catch {
    // 项目编码退化显示 id 前缀，不挡列表
  }
}

async function load(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    if (keyword.value.trim()) qs.set('q', keyword.value.trim())
    if (projectId.value) qs.set('projectId', projectId.value)
    const data = await api.get(`/api/work-plans?${qs}`)
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
  editing.value = null
  Object.assign(form, {
    projectId: projectId.value || '',
    code: '',
    name: '',
    planStart: null,
    planEnd: null,
    note: '',
  })
  drawer.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    projectId: row.projectId ?? '',
    code: row.code ?? '',
    name: row.name ?? '',
    planStart: dateInput(row.planStart) || null,
    planEnd: dateInput(row.planEnd) || null,
    note: row.note ?? '',
  })
  drawer.value = true
}

async function save() {
  if (!editing.value && (!form.projectId || !form.name.trim())) {
    ElMessage.warning(t('common.required'))
    return
  }
  if (editing.value && !form.name.trim()) {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    if (editing.value) {
      await api.patch(`/api/work-plans/${editing.value.id}`, {
        name: form.name.trim(),
        planStart: form.planStart || null,
        planEnd: form.planEnd || null,
        note: form.note || null,
        version: editing.value.version,
      })
    } else {
      await api.post('/api/work-plans', {
        projectId: form.projectId,
        ...(form.code.trim() ? { code: form.code.trim() } : {}),
        name: form.name.trim(),
        planStart: form.planStart || null,
        planEnd: form.planEnd || null,
        note: form.note || null,
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

/** @param {any} row */
async function loadTasks(row, force = false) {
  if (taskState[row.id] && !force) return
  taskState[row.id] = { loading: true, error: '', items: taskState[row.id]?.items ?? [] }
  try {
    const data = await api.get(`/api/work-tasks?planId=${row.id}&limit=100`)
    taskState[row.id] = { loading: false, error: '', items: data.items ?? [] }
  } catch (err) {
    taskState[row.id] = { loading: false, error: msgOf(err), items: [] }
    ElMessage.error(taskState[row.id].error)
  }
}

function onExpand(row, expandedRows) {
  const open = Array.isArray(expandedRows) ? expandedRows.some((r) => r.id === row.id) : Boolean(expandedRows)
  if (open) loadTasks(row)
}

async function advanceTask(task, to) {
  advancing.value = task.id
  try {
    await api.post(`/api/work-tasks/${task.id}/advance`, { to })
    ElMessage.success(t('action.saved'))
    await loadTasks({ id: task.planId }, true)
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    advancing.value = ''
  }
}

function openReport(task) {
  reportFor.value = task
  Object.assign(reportForm, { progress: Number(task.progress ?? 0), content: '' })
  reportOpen.value = true
}

async function saveReport() {
  const progress = Number(reportForm.progress)
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    ElMessage.warning(t('common.required'))
    return
  }
  reporting.value = true
  try {
    await api.post('/api/progress-logs', {
      taskId: reportFor.value.id,
      progress,
      content: reportForm.content || null,
    })
    ElMessage.success(t('action.saved'))
    reportOpen.value = false
    await loadTasks({ id: reportFor.value.planId }, true)
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    reporting.value = false
  }
}

onMounted(() => {
  loadProjects()
  refresh()
})
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input
        v-model="keyword"
        :placeholder="t('f2.plans.search')"
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
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openNew">{{ t('f2.plans.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="items" v-loading="loading" border data-test="table" @expand-change="onExpand">
      <el-table-column type="expand" width="40">
        <template #default="{ row }">
          <div v-loading="taskState[row.id]?.loading" class="tasks">
            <div class="tasks-head">
              <span class="erp-weak">{{ t('f2.plans.tasks') }}</span>
            </div>
            <el-alert
              v-if="taskState[row.id]?.error"
              type="error"
              :title="taskState[row.id].error"
              :closable="false"
              show-icon
            />
            <el-table v-else-if="taskState[row.id]?.items?.length" :data="taskState[row.id].items" size="small" border>
              <el-table-column :label="t('f2.plans.taskCode')" width="150">
                <template #default="{ row: task }">
                  <span class="code erp-ellipsis" :title="task.code">{{ task.code }}</span>
                </template>
              </el-table-column>
              <el-table-column :label="t('f2.plans.taskTitle')" min-width="180">
                <template #default="{ row: task }">
                  <span class="erp-ellipsis" :title="task.title">{{ task.title }}</span>
                </template>
              </el-table-column>
              <el-table-column :label="t('f2.plans.assignee')" width="120">
                <template #default="{ row: task }">
                  <span v-if="task.assigneeId" class="mono erp-ellipsis" :title="task.assigneeId">
                    {{ memberName(task.assigneeId) }}
                  </span>
                  <span v-else class="erp-weak">{{ t('common.none') }}</span>
                </template>
              </el-table-column>
              <el-table-column :label="t('f2.status')" width="110">
                <template #default="{ row: task }">
                  <el-tag
                    size="small"
                    round
                    effect="plain"
                    :type="task.status === 'done' ? 'success' : task.status === 'doing' ? 'warning' : 'info'"
                  >
                    {{ t(`f2.wstatus.${task.status}`) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column :label="t('f2.progress')" width="160">
                <template #default="{ row: task }">
                  <el-progress :percentage="Number(task.progress ?? 0)" :stroke-width="8" />
                </template>
              </el-table-column>
              <el-table-column :label="''" width="150" align="right">
                <template #default="{ row: task }">
                  <el-button v-if="canUpdate() && task.status !== 'done'" link type="primary" @click="openReport(task)">
                    {{ t('f2.report') }}
                  </el-button>
                  <el-dropdown
                    v-if="canUpdate() && task.allowed?.length"
                    trigger="click"
                    :disabled="advancing === task.id"
                    @command="(to) => advanceTask(task, to)"
                  >
                    <el-button link type="primary" :loading="advancing === task.id">
                      {{ t('f2.plans.taskAdvance') }}<el-icon class="chev"><ArrowDown /></el-icon>
                    </el-button>
                    <template #dropdown>
                      <el-dropdown-menu>
                        <el-dropdown-item v-for="to in task.allowed" :key="to" :command="to">
                          {{ t(`f2.wstatus.${to}`) }}
                        </el-dropdown-item>
                      </el-dropdown-menu>
                    </template>
                  </el-dropdown>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty :image-size="48" :description="t('f2.plans.tasksEmpty')" />
              </template>
            </el-table>
            <el-empty
              v-else-if="taskState[row.id] && !taskState[row.id].loading"
              :image-size="48"
              :description="t('f2.plans.tasksEmpty')"
            />
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="code" :label="t('f2.plans.code')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" :label="t('f2.plans.name')" min-width="190">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.project')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.plans.planStart')" width="120">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.planStart) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.plans.planEnd')" width="120">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.planEnd) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.createdAt')" width="120">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="110" align="right">
        <template #default="{ row }">
          <el-button v-if="canUpdate()" link type="primary" @click="openEdit(row)">{{ t('action.edit') }}</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('f2.plans.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f2.plans.hint') }} · {{ t('f2.plans.expandHint') }} · {{ tp('page.loaded', { n: items.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer
    v-model="drawer"
    :title="editing ? t('f2.plans.edit') : t('f2.plans.new')"
    size="440px"
    data-test="plan-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f2.project')" :required="!editing">
        <el-select v-model="form.projectId" filterable :disabled="Boolean(editing)" style="width: 100%" :placeholder="t('f2.allProjects')">
          <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f2.plans.code')" :required="!editing">
        <el-input v-model="form.code" maxlength="64" :disabled="Boolean(editing)" data-test="f-code"  placeholder="留空自动生成"/>
      </el-form-item>
      <el-form-item :label="t('f2.plans.name')" required>
        <el-input v-model="form.name" maxlength="64" data-test="f-name" />
      </el-form-item>
      <el-form-item :label="t('f2.plans.planStart')">
        <el-date-picker v-model="form.planStart" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f2.plans.planEnd')">
        <el-date-picker v-model="form.planEnd" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f2.plans.note')">
        <el-input v-model="form.note" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-dialog v-model="reportOpen" :title="t('f2.plans.reportTitle')" width="380px">
    <el-form label-position="top">
      <el-form-item :label="t('f2.plans.taskTitle')">
        <span class="erp-ellipsis" :title="reportFor?.title">{{ reportFor?.title }}</span>
      </el-form-item>
      <el-form-item :label="t('f2.progress')" required>
        <el-input-number v-model="reportForm.progress" :min="0" :max="100" :step="10" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f2.plans.reportContent')">
        <el-input v-model="reportForm.content" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="reportOpen = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="reporting" @click="saveReport">{{ t('action.save') }}</el-button>
    </template>
    <div class="erp-weak dialog-hint">{{ t('f2.plans.reportHint') }}</div>
  </el-dialog>
</template>

<style scoped>
.search {
  width: 240px;
}
.filter {
  width: 200px;
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
.chev {
  margin-left: 2px;
}
.tasks {
  padding: 8px var(--erp-gap);
  min-height: 48px;
}
.tasks-head {
  margin-bottom: 8px;
}
.dialog-hint {
  margin-top: 4px;
}
@media (max-width: 900px) {
  .search,
  .filter {
    width: 100%;
  }
}
</style>
