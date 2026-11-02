<script setup>
/**
 * 验收单（隐蔽 / 整体）：建单时把验收项整存整取，出结论走
 * `POST /api/acceptances/:id/advance` { to, conclusion }，可行结论只取后端 allowed。
 * 整体验收通过后后端会把项目推进到 pending_acceptance，前端不预判。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDateTime, shortId } from '../format.js'

const STATUSES = ['draft', 'passed', 'failed']
const TYPES = ['hidden', 'overall']
const RESULTS = ['pass', 'fail', 'na']

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const projectId = ref('')
const type = ref('')
const status = ref('')

const projects = ref([])
const projectMap = computed(() => new Map(projects.value.map((p) => [p.id, p])))
const projectCode = (id) => projectMap.value.get(id)?.code ?? (id ? shortId(id) : t('common.none'))

/** 后端 list 不接 q：搜索过滤已加载的行 */
const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return items.value
  return items.value.filter((row) =>
    [row.code, projectCode(row.projectId), row.conclusion]
      .some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const form = reactive({ projectId: '', code: '', type: 'hidden', conclusion: '', items: [] })

const detailOpen = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
/** 详情接口失败：抽屉里给原因，不假装“没有验收项” */
const detailError = ref('')

const advanceOpen = ref(false)
const advanceRow = ref(null)
const advanceTo = ref('passed')
const advanceConclusion = ref('')
const advancing = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('work:create')
const canUpdate = () => has('work:update')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

const statusTagType = (s) => (s === 'passed' ? 'success' : s === 'failed' ? 'danger' : 'info')

async function loadProjects() {
  try {
    const data = await api.get('/api/projects?limit=100')
    projects.value = data.items ?? []
  } catch {
    // 项目编码退化显示 id 前缀
  }
}

async function load(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    if (projectId.value) qs.set('projectId', projectId.value)
    if (type.value) qs.set('type', type.value)
    if (status.value) qs.set('status', status.value)
    const data = await api.get(`/api/acceptances?${qs}`)
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

function blankItem() {
  return { name: '', result: 'pass', note: '' }
}

function openNew() {
  editing.value = null
  Object.assign(form, {
    projectId: projectId.value || '',
    code: '',
    type: 'hidden',
    conclusion: '',
    items: [blankItem()],
  })
  drawer.value = true
}

async function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    projectId: row.projectId ?? '',
    code: row.code ?? '',
    type: row.type ?? 'hidden',
    conclusion: row.conclusion ?? '',
    items: [blankItem()],
  })
  drawer.value = true
  try {
    const data = await api.get(`/api/acceptances/${row.id}`)
    form.items = (data.items ?? []).map((x) => ({ name: x.name, result: x.result, note: x.note ?? '' }))
    if (!form.items.length) form.items = [blankItem()]
  } catch (err) {
    ElMessage.error(msgOf(err))
  }
}

function addItem() {
  form.items.push(blankItem())
}

function removeItem(index) {
  form.items.splice(index, 1)
  if (!form.items.length) form.items.push(blankItem())
}

async function save() {
  const rows = form.items
    .filter((x) => x.name.trim())
    .map((x) => ({ name: x.name.trim(), result: x.result, note: x.note || null }))
  if (!rows.length) {
    ElMessage.warning(t('common.required'))
    return
  }
  if (!editing.value && (!form.projectId || !form.type)) {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    if (editing.value) {
      await api.patch(`/api/acceptances/${editing.value.id}`, {
        conclusion: form.conclusion || null,
        items: rows,
        version: editing.value.version,
      })
    } else {
      await api.post('/api/acceptances', {
        projectId: form.projectId,
        ...(form.code.trim() ? { code: form.code.trim() } : {}),
        type: form.type,
        conclusion: form.conclusion || null,
        items: rows,
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

function openAdvance(row, to) {
  advanceRow.value = row
  advanceTo.value = to
  advanceConclusion.value = row.conclusion ?? ''
  advanceOpen.value = true
}

async function doAdvance() {
  if (!advanceRow.value) return
  advancing.value = advanceRow.value.id
  try {
    await api.post(`/api/acceptances/${advanceRow.value.id}/advance`, {
      to: advanceTo.value,
      conclusion: advanceConclusion.value || null,
    })
    ElMessage.success(t('action.saved'))
    advanceOpen.value = false
    refresh()
  } catch (err) {
    // 整体验收通过但项目不在 constructing 时后端 409：reason 直接给用户看
    ElMessage.error(msgOf(err))
  } finally {
    advancing.value = ''
  }
}

async function openDetail(row) {
  detail.value = row
  detailOpen.value = true
  detailLoading.value = true
  detailError.value = ''
  try {
    detail.value = await api.get(`/api/acceptances/${row.id}`)
  } catch (err) {
    detailError.value = msgOf(err)
    ElMessage.error(detailError.value)
  } finally {
    detailLoading.value = false
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
        :placeholder="t('f2.acc.search')"
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
      <el-select v-model="type" clearable class="filter" :placeholder="t('f2.allTypes')" @change="refresh">
        <el-option v-for="k in TYPES" :key="k" :value="k" :label="t(`f2.atype.${k}`)" />
      </el-select>
      <el-select v-model="status" clearable class="filter" :placeholder="t('f2.allStatus')" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`f2.astatus.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openNew">{{ t('f2.acc.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column prop="code" :label="t('f2.acc.code')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.project')" min-width="150">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.acc.type')" width="120">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="t(`f2.atype.${row.type}`)">{{ t(`f2.atype.${row.type}`) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.status')" width="110">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" :type="statusTagType(row.status)">
            {{ t(`f2.astatus.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.acc.items')" width="90" align="right">
        <template #default="{ row }">{{ (row.items ?? []).length }}</template>
      </el-table-column>
      <el-table-column :label="t('f2.acc.conclusion')" min-width="200">
        <template #default="{ row }">
          <span v-if="row.conclusion" class="erp-clamp-2" :title="row.conclusion">{{ row.conclusion }}</span>
          <span v-else class="erp-weak">{{ t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f2.createdAt')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDateTime(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="210" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ t('f2.detail') }}</el-button>
          <el-button v-if="canUpdate() && row.status === 'draft'" link type="primary" @click="openEdit(row)">
            {{ t('action.edit') }}
          </el-button>
          <el-dropdown
            v-if="canUpdate() && row.allowed?.length"
            trigger="click"
            :disabled="advancing === row.id"
            @command="(to) => openAdvance(row, to)"
          >
            <el-button link type="primary" :loading="advancing === row.id">
              {{ t('action.advance') }}<el-icon class="chev"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="to in row.allowed" :key="to" :command="to">
                  {{ to === 'passed' ? t('f2.acc.markPassed') : t('f2.acc.markFailed') }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('f2.acc.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f2.acc.hint') }} · {{ tp('page.loaded', { n: shown.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer
    v-model="drawer"
    :title="editing ? t('f2.acc.edit') : t('f2.acc.new')"
    size="620px"
    data-test="acceptance-drawer"
  >
    <el-form label-position="top">
      <el-form-item :label="t('f2.project')" :required="!editing">
        <el-select v-model="form.projectId" filterable :disabled="Boolean(editing)" style="width: 100%">
          <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('f2.acc.code')" :required="!editing">
        <el-input v-model="form.code" maxlength="64" :disabled="Boolean(editing)" data-test="f-code"  placeholder="留空自动生成"/>
      </el-form-item>
      <el-form-item :label="t('f2.acc.type')" :required="!editing">
        <el-select v-model="form.type" :disabled="Boolean(editing)" style="width: 100%">
          <el-option v-for="k in TYPES" :key="k" :value="k" :label="t(`f2.atype.${k}`)" />
        </el-select>
      </el-form-item>

      <div class="erp-card-head lines-head">
        <span class="erp-card-title">{{ t('f2.acc.items') }}</span>
        <el-button link type="primary" @click="addItem">{{ t('f2.acc.addItem') }}</el-button>
      </div>
      <el-table :data="form.items" size="small" border>
        <el-table-column type="index" :label="t('line.no')" width="48" />
        <el-table-column :label="t('f2.acc.itemName')" min-width="160">
          <template #default="{ row }">
            <el-input v-model="row.name" maxlength="64" />
          </template>
        </el-table-column>
        <el-table-column :label="t('f2.acc.itemResult')" width="120">
          <template #default="{ row }">
            <el-select v-model="row.result" style="width: 100%">
              <el-option v-for="r in RESULTS" :key="r" :value="r" :label="t(`f2.aresult.${r}`)" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column :label="t('f2.acc.itemNote')" min-width="140">
          <template #default="{ row }">
            <el-input v-model="row.note" maxlength="500" />
          </template>
        </el-table-column>
        <el-table-column :label="''" width="70" align="right">
          <template #default="{ $index }">
            <el-button link type="danger" @click="removeItem($index)">{{ t('f2.acc.removeItem') }}</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty :image-size="40" :description="t('f2.acc.itemsEmpty')" />
        </template>
      </el-table>

      <el-form-item :label="t('f2.acc.conclusion')" class="conclusion">
        <el-input v-model="form.conclusion" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-dialog v-model="advanceOpen" :title="t('f2.acc.advanceTitle')" width="420px">
    <el-form label-position="top">
      <el-form-item :label="t('f2.status')">
        <el-tag size="small" round effect="plain" :type="advanceTo === 'passed' ? 'success' : 'danger'">
          {{ advanceTo === 'passed' ? t('f2.acc.markPassed') : t('f2.acc.markFailed') }}
        </el-tag>
      </el-form-item>
      <el-form-item :label="t('f2.acc.conclusion')">
        <el-input v-model="advanceConclusion" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
    <div class="erp-weak">{{ t('f2.acc.advanceHint') }}</div>
    <template #footer>
      <el-button @click="advanceOpen = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="Boolean(advancing)" @click="doAdvance">{{ t('action.save') }}</el-button>
    </template>
  </el-dialog>

  <el-drawer v-model="detailOpen" :title="t('f2.acc.detailTitle')" size="520px" data-test="acceptance-detail">
    <div v-loading="detailLoading" class="detail">
      <el-alert v-if="detailError" type="error" :title="detailError" :closable="false" show-icon />
      <template v-else-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item :label="t('f2.acc.code')">{{ detail.code }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.status')">{{ t(`f2.astatus.${detail.status}`) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.project')">{{ projectCode(detail.projectId) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.acc.type')">{{ t(`f2.atype.${detail.type}`) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f2.createdAt')" :span="2">
            {{ fmtDateTime(detail.createdAt) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f2.acc.conclusion')" :span="2">
            <span class="erp-clamp-2" :title="detail.conclusion">{{ detail.conclusion || t('common.none') }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <div class="erp-card-head lines-head">
          <span class="erp-card-title">{{ t('f2.acc.items') }}</span>
        </div>
        <el-table :data="detail.items ?? []" size="small" border>
          <el-table-column type="index" :label="t('line.no')" width="48" />
          <el-table-column :label="t('f2.acc.itemName')" min-width="150">
            <template #default="{ row }">
              <span class="erp-ellipsis" :title="row.name">{{ row.name }}</span>
            </template>
          </el-table-column>
          <el-table-column :label="t('f2.acc.itemResult')" width="100">
            <template #default="{ row }">{{ t(`f2.aresult.${row.result}`) }}</template>
          </el-table-column>
          <el-table-column :label="t('f2.acc.itemNote')" min-width="140">
            <template #default="{ row }">
              <span class="erp-clamp-2" :title="row.note">{{ row.note || t('common.none') }}</span>
            </template>
          </el-table-column>
          <template #empty>
            <el-empty :image-size="40" :description="t('f2.acc.itemsEmpty')" />
          </template>
        </el-table>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.search {
  width: 200px;
}
.filter {
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
.chev {
  margin-left: 2px;
}
.lines-head {
  margin-top: var(--erp-gap);
}
.conclusion {
  margin-top: var(--erp-gap);
}
.detail {
  min-height: 140px;
}
@media (max-width: 900px) {
  .search,
  .filter {
    width: 100%;
  }
}
</style>
