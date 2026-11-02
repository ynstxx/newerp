<script setup>
/**
 * 工时登记：`GET /api/labor-hours?projectId=&userId=` 是游标分页。
 * 后端 list 目前只认 projectId / userId / taskId，没有 from/to —— 所以日期范围
 * 在前端过滤**已加载**的行（底栏仍是游标「加载更多」），hint 里写清楚这点。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { dateInput, fmtDate, fmtDateTime, memberName, shortId } from '../format.js'

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const projectId = ref('')
const userId = ref('')
const range = ref(null)
const keyword = ref('')

const projects = ref([])
const projectMap = computed(() => new Map(projects.value.map((p) => [p.id, p])))
const projectCode = (id) => projectMap.value.get(id)?.code ?? (id ? shortId(id) : t('common.none'))

/** 日期范围只过滤已加载的行；关键字过滤项目/任务/备注 */
const shown = computed(() => {
  const from = range.value?.[0] ? String(range.value[0]).slice(0, 10) : ''
  const to = range.value?.[1] ? String(range.value[1]).slice(0, 10) : ''
  const k = keyword.value.trim().toLowerCase()
  return items.value.filter((row) => {
    const day = String(row.workDate ?? '').slice(0, 10)
    if (from && day < from) return false
    if (to && day > to) return false
    if (!k) return true
    return [projectCode(row.projectId), row.note, row.taskId]
      .some((v) => String(v ?? '').toLowerCase().includes(k))
  })
})

/** 已加载合计：列表没有后端汇总接口，前端只对可见行求和 */
const totalHours = computed(() => shown.value.reduce((sum, r) => sum + Number(r.hours ?? 0), 0))

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const form = reactive({ projectId: '', userId: '', taskId: '', workDate: null, hours: 8, note: '' })

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('work:create')
const canUpdate = () => has('work:update')
const canDelete = () => has('work:delete')
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
    if (projectId.value) qs.set('projectId', projectId.value)
    if (userId.value) qs.set('userId', userId.value)
    // from/to 后端暂不认，仍旧传：后端补上后无需改前端
    if (range.value?.[0]) qs.set('from', String(range.value[0]).slice(0, 10))
    if (range.value?.[1]) qs.set('to', String(range.value[1]).slice(0, 10))
    const data = await api.get(`/api/labor-hours?${qs}`)
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
    userId: state.user?.id ?? '',
    taskId: '',
    workDate: dateInput(new Date()) || null,
    hours: 8,
    note: '',
  })
  drawer.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    projectId: row.projectId ?? '',
    userId: row.userId ?? '',
    taskId: row.taskId ?? '',
    workDate: dateInput(row.workDate) || null,
    hours: Number(row.hours ?? 0),
    note: row.note ?? '',
  })
  drawer.value = true
}

async function save() {
  if (!editing.value && !form.projectId) {
    ElMessage.warning(t('f2.labor.projectRequired'))
    return
  }
  if (!form.workDate || Number(form.hours) <= 0) {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    if (editing.value) {
      const patch = {
        taskId: form.taskId || null,
        workDate: form.workDate,
        hours: Number(form.hours),
        note: form.note || null,
        version: editing.value.version,
      }
      // 后端把空 userId 当错误，清空选择时表示不改
      if (form.userId) patch.userId = form.userId
      await api.patch(`/api/labor-hours/${editing.value.id}`, patch)
    } else {
      await api.post('/api/labor-hours', {
        projectId: form.projectId,
        taskId: form.taskId || null,
        userId: form.userId || null,
        workDate: form.workDate,
        hours: Number(form.hours),
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

async function remove(row) {
  try {
    await ElMessageBox.confirm(t('f2.labor.confirmDelete'), t('f2.labor.delete'), { type: 'warning' })
  } catch {
    return
  }
  try {
    await api.del(`/api/labor-hours/${row.id}`)
    ElMessage.success(t('f2.labor.deleted'))
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
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
        :placeholder="t('f2.labor.search')"
        clearable
        class="search"
        data-test="search"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-select v-model="projectId" clearable filterable class="filter" :placeholder="t('f2.allProjects')" @change="refresh">
        <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
      </el-select>
      <el-select v-model="userId" clearable filterable class="filter" :placeholder="t('f2.allUsers')" @change="refresh">
        <el-option v-for="m in state.members" :key="m.userId" :value="m.userId" :label="m.displayName" />
      </el-select>
      <el-date-picker
        v-model="range"
        type="daterange"
        value-format="YYYY-MM-DD"
        class="range"
        :start-placeholder="t('f2.labor.from')"
        :end-placeholder="t('f2.labor.to')"
      />
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openNew">{{ t('f2.labor.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="(row) => canUpdate() && openEdit(row)">
      <el-table-column :label="t('f2.labor.workDate')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.workDate) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.project')" min-width="170">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.user')" width="130">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.userId">{{ memberName(row.userId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.labor.hours')" width="100" align="right">
        <template #default="{ row }">{{ Number(row.hours) }}</template>
      </el-table-column>
      <el-table-column :label="t('f2.labor.task')" width="120">
        <template #default="{ row }">
          <span v-if="row.taskId" class="code erp-ellipsis" :title="row.taskId">{{ shortId(row.taskId) }}</span>
          <span v-else class="erp-weak">{{ t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.note')" min-width="200">
        <template #default="{ row }">
          <span v-if="row.note" class="erp-ellipsis" :title="row.note">{{ row.note }}</span>
          <span v-else class="erp-weak">{{ t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.createdAt')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDateTime(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="140" align="right">
        <template #default="{ row }">
          <el-button v-if="canUpdate()" link type="primary" @click="openEdit(row)">{{ t('action.edit') }}</el-button>
          <el-button v-if="canDelete()" link type="danger" @click="remove(row)">{{ t('f2.labor.delete') }}</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('f2.labor.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f2.labor.hint') }} · {{ t('f2.labor.total') }} {{ totalHours }} {{ t('f2.labor.hoursUnit') }} ·
      {{ tp('page.loaded', { n: shown.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer
    v-model="drawer"
    :title="editing ? t('f2.labor.edit') : t('f2.labor.new')"
    size="440px"
    data-test="labor-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f2.project')" :required="!editing">
        <el-select
          v-model="form.projectId"
          filterable
          :disabled="Boolean(editing)"
          style="width: 100%"
          :placeholder="t('f2.labor.pickProject')"
        >
          <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f2.labor.workDate')" required>
        <el-date-picker v-model="form.workDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f2.labor.hours')" required>
        <el-input-number v-model="form.hours" :min="0.5" :max="24" :step="0.5" :precision="1" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('f2.user')">
        <el-select v-model="form.userId" clearable filterable style="width: 100%" :placeholder="t('f2.labor.userHint')">
          <el-option v-for="m in state.members" :key="m.userId" :value="m.userId" :label="m.displayName" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f2.labor.task')">
        <el-input v-model="form.taskId" maxlength="36" :placeholder="t('f2.labor.taskHint')" />
      </el-form-item>
      <el-form-item :label="t('f2.note')">
        <el-input v-model="form.note" type="textarea" :rows="3" maxlength="500" />
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
  width: 180px;
}
.filter {
  width: 170px;
}
.range {
  width: 240px;
}
.err {
  margin-bottom: 12px;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
@media (max-width: 900px) {
  .search,
  .filter,
  .range {
    width: 100%;
  }
}
</style>
