<script setup>
/**
 * 项目列表：项目由商机赢单自动生成，所以没有「新建」。
 * 推进下拉只渲染后端 allowed —— 直接推到 signed 时后端会 409，
 * 这里不预判，原样展示 error.details.reason。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { dateInput, fmtDate, fmtDateTime, money, shortId, memberName } from '../format.js'

const STATUSES = ['approved', 'designing', 'quoting', 'signed', 'terminated', 'draft']

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const status = ref('')

const parties = ref([])
const partyMap = computed(() => new Map(parties.value.map((p) => [p.id, p])))
const partyLabel = (id) => {
  const p = partyMap.value.get(id)
  return p ? `${p.code} ${p.name}` : ''
}
const partyName = (id) => partyMap.value.get(id)?.name ?? (id ? shortId(id) : t('common.none'))

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const advancing = ref('')
const form = reactive({ name: '', pmUserId: '', startDate: null, endDate: null, note: '' })

const historyOpen = ref(false)
const historyFor = ref(null)
const logs = ref([])
const logsLoading = ref(false)
/** 历史接口失败：抽屉里给原因，不假装“没有记录” */
const logsError = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canUpdate = () => has('project:update')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

async function loadParties() {
  try {
    const data = await api.get('/api/parties?limit=100')
    parties.value = data.items ?? []
  } catch {
    // 客户名拿不到就退化显示 id 前缀
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
    const data = await api.get(`/api/projects?${qs}`)
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

function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    name: row.name ?? '',
    pmUserId: row.pmUserId ?? '',
    startDate: dateInput(row.startDate) || null,
    endDate: dateInput(row.endDate) || null,
    note: row.note ?? '',
  })
  drawer.value = true
}

async function save() {
  if (!form.name.trim()) {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    await api.patch(`/api/projects/${editing.value.id}`, {
      name: form.name.trim(),
      pmUserId: form.pmUserId || null,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      note: form.note || null,
      version: editing.value.version,
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
    await api.post(`/api/projects/${row.id}/advance`, { to })
    ElMessage.success(t('action.saved'))
    refresh()
  } catch (err) {
    // signed 只能由合同签署联动：后端 reason 直接给用户看
    ElMessage.error(msgOf(err))
  } finally {
    advancing.value = ''
  }
}

async function openHistory(row) {
  historyFor.value = row
  logs.value = []
  historyOpen.value = true
  logsLoading.value = true
  logsError.value = ''
  try {
    const data = await api.get(`/api/projects/${row.id}/stages`)
    logs.value = data.items ?? []
  } catch (err) {
    logsError.value = msgOf(err)
    ElMessage.error(logsError.value)
  } finally {
    logsLoading.value = false
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
        :placeholder="t('proj.search')"
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
      <el-select v-model="status" clearable :placeholder="t('proj.status')" class="status" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`pstatus.${k}`)" />
      </el-select>
    </template>

    <!-- 没有新建：项目由商机赢单生成，留一句说明而不是禁用按钮 -->
    <template #actions>
      <span class="erp-weak note">{{ t('proj.autoNote') }}</span>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table
      :data="items"
      v-loading="loading"
      border
      data-test="table"
      @row-dblclick="openHistory"
    >
      <el-table-column prop="code" :label="t('proj.code')" width="160">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" :label="t('proj.name')" min-width="190">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('proj.party')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="partyLabel(row.partyId) || partyName(row.partyId)">
            {{ partyName(row.partyId) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('proj.status')" width="110">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" :type="row.status === 'signed' ? 'success' : row.status === 'terminated' ? 'danger' : 'primary'">
            {{ t(`pstatus.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('proj.contractAmt')" width="140" align="right">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="String(row.contractAmt)">{{ money(row.contractAmt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('proj.pm')" width="110">
        <template #default="{ row }">
          <span v-if="row.pmUserId" class="erp-ellipsis mono" :title="row.pmUserId">{{ memberName(row.pmUserId) }}</span>
          <span v-else class="erp-weak">{{ t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('proj.createdAt')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="180" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openHistory(row)">{{ t('proj.stages') }}</el-button>
          <el-button v-if="canUpdate()" link type="primary" @click="openEdit(row)">{{ t('action.edit') }}</el-button>
          <el-dropdown
            v-if="canUpdate() && row.allowed?.length"
            trigger="click"
            :disabled="advancing === row.id"
            @command="(to) => advance(row, to)"
          >
            <el-button link type="primary" :loading="advancing === row.id">
              {{ t('action.advance') }}<el-icon class="chev"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="to in row.allowed" :key="to" :command="to">
                  {{ t(`pstatus.${to}`) }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('proj.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('proj.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="drawer" :title="t('proj.edit')" size="440px" data-test="proj-drawer">
    <el-form label-position="top">
      <el-form-item :label="t('proj.code')">
        <el-input :model-value="editing?.code" disabled />
      </el-form-item>
      <el-form-item :label="t('proj.name')" required>
        <el-input v-model="form.name" maxlength="64" data-test="f-name" />
      </el-form-item>
      <el-form-item :label="t('proj.pm')">
        <el-input v-model="form.pmUserId" maxlength="36" :placeholder="t('proj.pmHint')" />
      </el-form-item>
      <el-form-item :label="t('proj.startDate')">
        <el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('proj.endDate')">
        <el-date-picker v-model="form.endDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
      </el-form-item>
      <el-form-item :label="t('proj.note')">
        <el-input v-model="form.note" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>

  <el-drawer v-model="historyOpen" :title="t('proj.stages')" size="440px" data-test="proj-history">
    <div v-loading="logsLoading" class="history">
      <div v-if="historyFor" class="his-head">
        <span class="code">{{ historyFor.code }}</span>
        <span class="erp-ellipsis" :title="historyFor.name">{{ historyFor.name }}</span>
      </div>
      <el-alert v-if="logsError" type="error" :title="logsError" :closable="false" show-icon />
      <el-timeline v-if="logs.length">
        <el-timeline-item
          v-for="log in logs"
          :key="log.id"
          :timestamp="fmtDateTime(log.at)"
          :type="log.toStatus === 'signed' ? 'success' : log.toStatus === 'terminated' ? 'danger' : 'primary'"
        >
          <div class="his-line">
            <template v-if="log.fromStatus">{{ t(`pstatus.${log.fromStatus}`) }} → </template>
            <span class="his-to">{{ t(`pstatus.${log.toStatus}`) }}</span>
          </div>
          <div v-if="log.note" class="erp-weak his-note erp-clamp-2" :title="log.note">{{ log.note }}</div>
        </el-timeline-item>
      </el-timeline>
      <el-empty
        v-else-if="!logsError && !logsLoading"
        :image-size="56"
        :description="t('proj.historyEmpty')"
      />
    </div>
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
.note {
  text-align: right;
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
.history {
  min-height: 120px;
}
.his-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  min-width: 0;
}
.his-line {
  font-size: 13px;
}
.his-to {
  color: var(--erp-text);
  font-weight: 600;
}
.his-note {
  margin-top: 2px;
}
@media (max-width: 900px) {
  .search,
  .status {
    width: 100%;
  }
  .note {
    text-align: left;
  }
}
</style>
