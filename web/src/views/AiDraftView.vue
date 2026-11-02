<script setup>
/**
 * AI 草稿：列表 + 详情（payload / preview 对照）。
 * 行操作完全按后端 allowed 渲染 —— 通过 / 驳回 / 落库不在这里抄状态机。
 * status='failed' 的草稿显示 error，并允许再次落库（重试）。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDateTime, memberName, shortId } from '../format.js'

const STATUSES = ['draft', 'pending', 'approved', 'applied', 'rejected', 'failed']

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const status = ref('')

const detailOpen = ref(false)
const detail = ref(null)
const detailLoading = ref(false)
const detailError = ref('')
const acting = ref('')

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canApprove = () => has('ai:approve')
const canApply = () => has('ai:apply')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)
const pretty = (v) => JSON.stringify(v ?? null, null, 2)
const isDiff = (preview) => Array.isArray(preview?.diff) && preview.diff.length > 0
const allows = (row, next) => Array.isArray(row?.allowed) && row.allowed.includes(next)

/** 落库按钮：failed 的草稿是"重试"，approved 的才是首次落库 */
const applyLabel = (row) => (row.status === 'failed' ? t('f4.draft.retry') : t('f4.draft.apply'))

async function load(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    if (status.value) qs.set('status', status.value)
    const data = await api.get(`/api/ai/drafts?${qs}`)
    items.value = reset ? data.items : [...items.value, ...data.items]
    cursor.value = data.nextCursor ?? ''
  } catch (err) {
    // ai:view 也会因未配置模型而 503：把 reason 留在页面上
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
  detailError.value = ''
  detailOpen.value = true
  detailLoading.value = true
  try {
    detail.value = await api.get(`/api/ai/drafts/${row.id}`)
  } catch (err) {
    detailError.value = msgOf(err)
    ElMessage.error(detailError.value)
  } finally {
    detailLoading.value = false
  }
}

async function approve(row) {
  acting.value = row.id
  try {
    await api.post(`/api/ai/drafts/${row.id}/approve`)
    ElMessage.success(t('f4.draft.approved'))
    detailOpen.value = false
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    acting.value = ''
  }
}

async function reject(row) {
  let reason = ''
  try {
    const { value } = await ElMessageBox.prompt(t('f4.draft.rejectReason'), t('f4.draft.reject'), {
      confirmButtonText: t('f4.draft.reject'),
      cancelButtonText: t('action.cancel'),
      inputType: 'textarea',
      inputValidator: (v) => (String(v ?? '').trim() ? true : t('f4.draft.rejectRequired')),
    })
    reason = String(value ?? '').trim()
  } catch {
    return
  }
  acting.value = row.id
  try {
    await api.post(`/api/ai/drafts/${row.id}/reject`, { reason })
    ElMessage.success(t('f4.draft.rejected'))
    detailOpen.value = false
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    acting.value = ''
  }
}

async function apply(row) {
  acting.value = row.id
  try {
    const out = await api.post(`/api/ai/drafts/${row.id}/apply`)
    const applied = out?.draft
    ElMessage.success(
      applied?.appliedRefId
        ? `${t('f4.draft.applied')} · ${applied.appliedRefType ?? ''} ${shortId(applied.appliedRefId)}`
        : t('f4.draft.applied'),
    )
    detailOpen.value = false
    refresh()
  } catch (err) {
    // 落库前重新校验，payload 不合规 / 缺库存等 reason 直接展示
    ElMessage.error(msgOf(err))
    refresh()
  } finally {
    acting.value = ''
  }
}

const counts = computed(() => items.value.length)

onMounted(() => load(true))
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-select v-model="status" clearable :placeholder="t('f4.draft.status')" class="status" @change="refresh">
        <el-option v-for="k in STATUSES" :key="k" :value="k" :label="t(`f4.dstatus.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <el-button :loading="loading" @click="refresh">{{ t('top.refresh') }}</el-button>
    </template>

    <el-alert
      v-if="error"
      class="err"
      type="error"
      :title="t('f4.draft.unavailable')"
      :closable="false"
      show-icon
    >
      <div class="err-body">{{ error }}</div>
    </el-alert>

    <el-table :data="items" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column :label="t('f4.draft.tool')" min-width="170">
        <template #default="{ row }">
          <span class="mono erp-ellipsis" :title="row.toolName">{{ row.toolName }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.draft.status')" width="110">
        <template #default="{ row }">
          <el-tag
            size="small"
            round
            effect="plain"
            :type="row.status === 'applied' ? 'success' : row.status === 'failed' || row.status === 'rejected' ? 'danger' : row.status === 'pending' ? 'warning' : 'info'"
          >
            {{ t(`f4.dstatus.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.draft.error')" min-width="180">
        <template #default="{ row }">
          <span v-if="row.error" class="err-text erp-ellipsis" :title="row.error">{{ row.error }}</span>
          <span v-else class="erp-weak">{{ t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.draft.submitter')" width="120">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.submitterId">{{ memberName(row.submitterId) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f4.draft.createdAt')" width="120">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDateTime(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="230" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ t('f4.draft.detail') }}</el-button>
          <el-button
            v-if="canApprove() && allows(row, 'approved')"
            link
            type="primary"
            :loading="acting === row.id"
            @click="approve(row)"
          >
            {{ t('f4.draft.approve') }}
          </el-button>
          <el-button
            v-if="canApprove() && allows(row, 'rejected')"
            link
            type="danger"
            :loading="acting === row.id"
            @click="reject(row)"
          >
            {{ t('f4.draft.reject') }}
          </el-button>
          <el-button
            v-if="canApply() && allows(row, 'applied')"
            link
            type="success"
            :loading="acting === row.id"
            data-test="apply"
            @click="apply(row)"
          >
            {{ applyLabel(row) }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('f4.draft.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f4.draft.hint') }} · {{ tp('page.loaded', { n: counts }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="detailOpen" :title="t('f4.draft.detail')" size="620px" data-test="draft-detail">
    <div v-loading="detailLoading" class="detail">
      <el-alert v-if="detailError" type="error" :title="detailError" :closable="false" show-icon />
      <template v-if="detail">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item :label="t('f4.draft.tool')" :span="2">
            <span class="mono erp-ellipsis" :title="detail.toolName">{{ detail.toolName }}</span>
          </el-descriptions-item>
          <el-descriptions-item :label="t('f4.draft.status')">
            {{ t(`f4.dstatus.${detail.status}`) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f4.draft.submitter')">
            {{ memberName(detail.submitterId) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('f4.draft.createdAt')">{{ fmtDateTime(detail.createdAt) }}</el-descriptions-item>
          <el-descriptions-item :label="t('f4.draft.updatedAt')">{{ fmtDateTime(detail.updatedAt) }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.appliedRefId" :label="t('f4.draft.appliedRef')" :span="2">
            <span class="mono">{{ detail.appliedRefType }} / {{ detail.appliedRefId }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-alert
          v-if="detail.error"
          class="block"
          type="error"
          :title="detail.status === 'failed' ? t('f4.draft.failedHint') : t('f4.draft.error')"
          :closable="false"
          show-icon
        >
          <div class="err-body">{{ detail.error }}</div>
        </el-alert>

        <div class="block">
          <div class="block-title erp-weak">{{ t('f4.draft.preview') }}</div>
          <div v-if="detail.preview?.summary" class="summary">{{ detail.preview.summary }}</div>
          <el-table v-if="isDiff(detail.preview)" :data="detail.preview.diff" border size="small">
            <el-table-column prop="label" :label="'field'" width="110">
              <template #default="{ row }">
                <span class="erp-ellipsis" :title="row.field">{{ row.label || row.field }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="'before'" min-width="120">
              <template #default="{ row }">
                <span class="erp-weak erp-ellipsis" :title="String(row.before ?? '')">{{ row.before ?? '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column :label="'after'" min-width="120">
              <template #default="{ row }">
                <span class="erp-ellipsis" :title="String(row.after ?? '')">{{ row.after ?? '—' }}</span>
              </template>
            </el-table-column>
          </el-table>
          <pre v-else class="json">{{ pretty(detail.preview) }}</pre>
        </div>

        <div class="block">
          <div class="block-title erp-weak">{{ t('f4.draft.payload') }}</div>
          <pre class="json">{{ pretty(detail.payload) }}</pre>
        </div>
      </template>
    </div>
    <template v-if="detail" #footer>
      <el-button @click="detailOpen = false">{{ t('action.cancel') }}</el-button>
      <el-button
        v-if="canApprove() && allows(detail, 'approved')"
        type="primary"
        :loading="acting === detail.id"
        @click="approve(detail)"
      >
        {{ t('f4.draft.approve') }}
      </el-button>
      <el-button
        v-if="canApprove() && allows(detail, 'rejected')"
        type="danger"
        plain
        :loading="acting === detail.id"
        @click="reject(detail)"
      >
        {{ t('f4.draft.reject') }}
      </el-button>
      <el-button
        v-if="canApply() && allows(detail, 'applied')"
        type="success"
        :loading="acting === detail.id"
        @click="apply(detail)"
      >
        {{ applyLabel(detail) }}
      </el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.status {
  width: 140px;
}
.err {
  margin-bottom: 12px;
}
.err-body {
  font-size: 13px;
  word-break: break-word;
}
.err-text {
  color: var(--erp-danger);
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.detail {
  min-height: 120px;
}
.block {
  margin-top: 16px;
}
.block-title {
  margin-bottom: 6px;
}
.summary {
  font-size: 13px;
  margin-bottom: 8px;
}
.json {
  margin: 0;
  padding: 10px;
  max-height: 260px;
  overflow: auto;
  background: var(--erp-surface-2);
  border: 1px solid var(--erp-border);
  border-radius: var(--erp-radius-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
@media (max-width: 900px) {
  .status {
    width: 100%;
  }
  .json {
    max-height: 180px;
  }
}
</style>
