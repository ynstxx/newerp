<script setup>
/**
 * 报价列表：报价由方案 BOM 生成，没有「新建」。
 * 后端 list 不接 q，所以搜索是「过滤已加载记录」，底栏仍靠游标加载更多。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDateTime, money, shortId } from '../format.js'

const STATUSES = computed(() => dict('quotationStatus'))

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const status = ref('')

const parties = ref([])
const partyMap = computed(() => new Map(parties.value.map((p) => [p.id, p])))
const partyName = (id) => partyMap.value.get(id)?.name ?? (id ? shortId(id) : t('common.none'))

const projects = ref([])
const projectMap = computed(() => new Map(projects.value.map((p) => [p.id, p])))
const projectCode = (id) => projectMap.value.get(id)?.code ?? (id ? shortId(id) : t('common.none'))

/** 搜索只作用在已经取回来的行上（后端没有 q 参数） */
const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return items.value
  return items.value.filter((row) =>
    [row.code, projectCode(row.projectId), partyName(row.partyId)]
      .some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})

const detailOpen = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
/** 明细接口失败：抽屉里显示原因，不留一张“没有明细”的假空表 */
const detailError = ref('')
const advancing = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canUpdate = () => has('quotation:update')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)
const total = computed(() => (detail.value?.lines ?? []).reduce((sum, l) => sum + Number(l.amount ?? 0), 0))

async function loadLookups() {
  try {
    const data = await api.get('/api/parties?limit=100')
    parties.value = data.items ?? []
  } catch {
    // 客户名退化显示 id 前缀
  }
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
    if (status.value) qs.set('status', status.value)
    const data = await api.get(`/api/quotations?${qs}`)
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

async function openDetail(row) {
  detail.value = row
  detailOpen.value = true
  detailLoading.value = true
  detailError.value = ''
  try {
    detail.value = await api.get(`/api/quotations/${row.id}`)
  } catch (err) {
    detailError.value = msgOf(err)
    ElMessage.error(detailError.value)
  } finally {
    detailLoading.value = false
  }
}

async function advance(row, to) {
  advancing.value = row.id
  try {
    await api.post(`/api/quotations/${row.id}/advance`, { to })
    ElMessage.success(t('action.saved'))
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    advancing.value = ''
  }
}

onMounted(() => {
  loadLookups()
  refresh()
})
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input v-model="keyword" :placeholder="t('quo.search')" clearable class="search" data-test="search">
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-select v-model="status" clearable :placeholder="t('quo.status')" class="status" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`qstatus.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <span class="erp-weak note">{{ t('quo.autoNote') }}</span>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column prop="code" :label="t('quo.code')" width="200">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('quo.project')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('quo.version')" width="90" align="center">
        <template #default="{ row }">v{{ row.version }}</template>
      </el-table-column>
      <el-table-column :label="t('quo.party')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="partyName(row.partyId)">{{ partyName(row.partyId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('quo.amount')" width="140" align="right">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="String(row.amount)">{{ money(row.amount) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('quo.status')" width="110">
        <template #default="{ row }">
          <el-tag
            size="small"
            round
            effect="plain"
            :type="row.status === 'accepted' ? 'success' : row.status === 'rejected' ? 'danger' : row.status === 'sent' ? 'warning' : 'info'"
          >
            {{ t(`qstatus.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('quo.sentAt')" width="140">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDateTime(row.sentAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="190" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ t('quo.detail') }}</el-button>
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
                  {{ t(`qstatus.${to}`) }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="keyword.trim() ? t('common.noMatch') : t('quo.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('quo.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
      <template v-if="keyword.trim()"> · {{ t('common.clientFilter') }}</template>
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="detailOpen" :title="t('quo.detailTitle')" size="640px" data-test="quo-drawer">
    <div v-loading="detailLoading" class="detail">
      <el-alert v-if="detailError" type="error" :title="detailError" :closable="false" show-icon />
      <div v-if="detail && !detailError" class="detail-head">
        <span class="code">{{ detail.code }}</span>
        <el-tag size="small" round effect="plain">{{ t(`qstatus.${detail.status}`) }}</el-tag>
        <span class="erp-weak">v{{ detail.version }}</span>
        <span class="erp-weak erp-ellipsis" :title="partyName(detail.partyId)">{{ partyName(detail.partyId) }}</span>
      </div>
      <el-table
        v-if="!detailError"
        :data="detail?.lines ?? []"
        border
        size="small"
        :empty-text="t('quo.linesEmpty')"
      >
        <el-table-column prop="lineNo" :label="t('line.no')" width="64" align="center" />
        <el-table-column :label="t('line.item')" min-width="140">
          <template #default="{ row }">
            <span class="erp-ellipsis" :title="row.itemName">{{ row.itemName }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('line.spec')" min-width="110">
          <template #default="{ row }">
            <span class="erp-ellipsis" :title="row.spec">{{ row.spec || t('common.none') }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="uom" :label="t('line.uom')" width="70" />
        <el-table-column :label="t('line.qty')" width="90" align="right">
          <template #default="{ row }">{{ row.qty }}</template>
        </el-table-column>
        <el-table-column :label="t('line.price')" width="120" align="right">
          <template #default="{ row }">{{ money(row.price) }}</template>
        </el-table-column>
        <el-table-column :label="t('line.amount')" width="130" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
      </el-table>
      <div v-if="!detailError" class="total">
        <span class="erp-weak">{{ t('common.total') }}</span>
        <strong>{{ money(total) }}</strong>
      </div>
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
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.chev {
  margin-left: 2px;
}
.detail {
  min-height: 160px;
}
.detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  min-width: 0;
}
.total {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--erp-border);
  margin-top: 12px;
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
