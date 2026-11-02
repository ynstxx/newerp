<script setup>
/**
 * 合同列表：合同由已接受的报价生成，没有「新建」。
 * 明细抽屉两段：lines（金额快照）+ terms（条款）。签约后同事务把项目置为已签约，二次确认。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDate, money, shortId } from '../format.js'

const STATUSES = computed(() => dict('contractStatus'))

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

/** 后端 list 不接 q：搜索过滤已加载的行 */
const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return items.value
  return items.value.filter((row) =>
    [row.code, row.name, projectCode(row.projectId), partyName(row.partyId)]
      .some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})

const detailOpen = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
/** 明细接口失败：抽屉里显示原因，不留一张“没有明细”的假空表 */
const detailError = ref('')
const signing = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canUpdate = () => has('contract:update')
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
    const data = await api.get(`/api/contracts?${qs}`)
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
    detail.value = await api.get(`/api/contracts/${row.id}`)
  } catch (err) {
    detailError.value = msgOf(err)
    ElMessage.error(detailError.value)
  } finally {
    detailLoading.value = false
  }
}

async function sign(row) {
  try {
    await ElMessageBox.confirm(t('contract.signConfirm'), t('contract.sign'), { type: 'warning' })
  } catch {
    return
  }
  signing.value = row.id
  try {
    await api.post(`/api/contracts/${row.id}/advance`, { to: 'signed' })
    ElMessage.success(t('contract.signed'))
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    signing.value = ''
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
      <el-input v-model="keyword" :placeholder="t('contract.search')" clearable class="search" data-test="search">
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-select v-model="status" clearable :placeholder="t('contract.status')" class="status" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`cstatus.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <span class="erp-weak note">{{ t('contract.autoNote') }}</span>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column prop="code" :label="t('contract.code')" width="170">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" :label="t('contract.name')" min-width="190">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('contract.project')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="projectCode(row.projectId)">{{ projectCode(row.projectId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('contract.party')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="partyName(row.partyId)">{{ partyName(row.partyId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('contract.amount')" width="140" align="right">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="String(row.amount)">{{ money(row.amount) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('contract.status')" width="100">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" :type="row.status === 'signed' ? 'success' : 'info'">
            {{ t(`cstatus.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('contract.signAt')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDate(row.signAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="170" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ t('contract.detail') }}</el-button>
          <el-button
            v-if="canUpdate() && row.allowed?.includes('signed')"
            link
            type="success"
            :loading="signing === row.id"
            @click="sign(row)"
          >
            {{ t('contract.sign') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="keyword.trim() ? t('common.noMatch') : t('contract.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('contract.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
      <template v-if="keyword.trim()"> · {{ t('common.clientFilter') }}</template>
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="detailOpen" :title="t('contract.detailTitle')" size="680px" data-test="contract-drawer">
    <div v-loading="detailLoading" class="detail">
      <el-alert v-if="detailError" type="error" :title="detailError" :closable="false" show-icon />
      <div v-if="detail && !detailError" class="detail-head">
        <span class="code">{{ detail.code }}</span>
        <span class="erp-ellipsis" :title="detail.name">{{ detail.name }}</span>
        <el-tag size="small" round effect="plain" :type="detail.status === 'signed' ? 'success' : 'info'">
          {{ t(`cstatus.${detail.status}`) }}
        </el-tag>
      </div>

      <div v-if="!detailError" class="sec-title">{{ t('contract.lines') }}</div>
      <el-table
        v-if="!detailError"
        :data="detail?.lines ?? []"
        border
        size="small"
        :empty-text="t('contract.linesEmpty')"
      >
        <el-table-column prop="lineNo" :label="t('line.no')" width="60" align="center" />
        <el-table-column :label="t('line.item')" min-width="130">
          <template #default="{ row }">
            <span class="erp-ellipsis" :title="row.itemName">{{ row.itemName }}</span>
          </template>
        </el-table-column>
        <el-table-column :label="t('line.spec')" min-width="100">
          <template #default="{ row }">
            <span class="erp-ellipsis" :title="row.spec">{{ row.spec || t('common.none') }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="uom" :label="t('line.uom')" width="64" />
        <el-table-column :label="t('line.qty')" width="80" align="right">
          <template #default="{ row }">{{ row.qty }}</template>
        </el-table-column>
        <el-table-column :label="t('line.price')" width="110" align="right">
          <template #default="{ row }">{{ money(row.price) }}</template>
        </el-table-column>
        <el-table-column :label="t('line.amount')" width="120" align="right">
          <template #default="{ row }">{{ money(row.amount) }}</template>
        </el-table-column>
      </el-table>
      <div v-if="!detailError" class="total">
        <span class="erp-weak">{{ t('common.total') }}</span>
        <strong>{{ money(total) }}</strong>
      </div>

      <div v-if="!detailError" class="sec-title">{{ t('contract.terms') }}</div>
      <ol v-if="!detailError && detail?.terms?.length" class="terms">
        <li v-for="term in detail.terms" :key="term.id">
          <div class="term-title">{{ term.seq }}. {{ term.title }}</div>
          <div class="erp-weak term-body erp-clamp-2" :title="term.content">{{ term.content }}</div>
        </li>
      </ol>
      <el-empty
        v-else-if="!detailError && !detailLoading"
        :image-size="48"
        :description="t('contract.termsEmpty')"
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
.code {
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
  margin-bottom: 14px;
  min-width: 0;
}
.sec-title {
  margin: 4px 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--erp-text);
}
.total {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  gap: 12px;
  padding: 10px 0 18px;
  border-bottom: 1px solid var(--erp-border);
  margin-bottom: 8px;
}
.terms {
  margin: 0;
  padding-left: 18px;
}
.terms li {
  margin-bottom: 10px;
}
.term-title {
  font-size: 13px;
  color: var(--erp-text);
}
.term-body {
  white-space: pre-wrap;
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
