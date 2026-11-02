<script setup>
/**
 * 站内信：未读优先（后端按 (未读, created_at, id) 三元游标排序），
 * 点开即标记已读（POST /api/notify/inbox/:id/read），底部「加载更多」。
 * 未读数优先用接口返回的 `unread`，缺失时按已加载行自己数。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import PageTemplate from '../components/PageTemplate.vue'
import { fmtDateTime } from '../format.js'

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const unread = ref(0)

const drawerOpen = ref(false)
const current = ref(null)
const readBusy = ref('')
const readAllBusy = ref(false)

const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

const kw = computed(() => keyword.value.trim().toLowerCase())
const shown = computed(() => {
  const k = kw.value
  if (!k) return items.value
  return items.value.filter((row) =>
    [row.title, row.body].some((v) => String(v ?? '').toLowerCase().includes(k)),
  )
})
const loadedUnread = computed(() => items.value.filter((row) => !row.readAt).length)

async function load(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    const data = await api.get(`/api/notify/inbox?${qs}`)
    items.value = reset ? data.items : [...items.value, ...data.items]
    cursor.value = data.nextCursor ?? ''
    unread.value = typeof data.unread === 'number' ? data.unread : loadedUnread.value
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

async function markRead(row) {
  if (!row || row.readAt || readBusy.value === row.id) return
  readBusy.value = row.id
  try {
    const updated = await api.post(`/api/notify/inbox/${row.id}/read`)
    Object.assign(row, updated)
    unread.value = Math.max(0, unread.value - 1)
    const idx = items.value.findIndex((it) => it.id === row.id)
    if (idx >= 0) items.value[idx] = { ...items.value[idx], ...updated }
    if (current.value?.id === row.id) current.value = { ...current.value, ...updated }
    ElMessage.success(t('f1.inbox.readDone'))
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    readBusy.value = ''
  }
}

function openDetail(row) {
  current.value = row
  drawerOpen.value = true
  // 点开即已读：失败只提示，不关抽屉
  markRead(row)
}

async function readAll() {
  readAllBusy.value = true
  try {
    await api.post('/api/notify/inbox/read-all')
    ElMessage.success(t('f1.inbox.readAllDone'))
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    readAllBusy.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input v-model="keyword" :placeholder="t('f1.inbox.search')" clearable class="search" data-test="search">
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>
      <el-tag v-if="unread" size="small" round effect="plain" type="warning">
        {{ tp('f1.inbox.unreadCount', { n: unread }) }}
      </el-tag>
    </template>

    <template #actions>
      <el-button :disabled="!unread" :loading="readAllBusy" data-test="inbox-read-all" @click="readAll">
        {{ t('f1.inbox.readAll') }}
      </el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="shown" v-loading="loading" border data-test="table" @row-dblclick="openDetail">
      <el-table-column :label="t('f1.inbox.status')" width="90">
        <template #default="{ row }">
          <span class="dot" :class="{ on: !row.readAt }" />
          <span class="erp-weak">{{ row.readAt ? t('f1.inbox.read') : t('f1.inbox.unread') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f1.inbox.title')" min-width="220">
        <template #default="{ row }">
          <span class="title erp-ellipsis" :class="{ bold: !row.readAt }" :title="row.title">{{ row.title }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('f1.inbox.body')" min-width="320">
        <template #default="{ row }">
          <div class="preview erp-clamp-2" :class="{ bold: !row.readAt }" :title="row.body">{{ row.body }}</div>
        </template>
      </el-table-column>
      <el-table-column :label="t('f1.inbox.time')" width="130">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDateTime(row.createdAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="160" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ t('f1.common.detail') }}</el-button>
          <el-button
            v-if="!row.readAt"
            link
            type="primary"
            :loading="readBusy === row.id"
            @click="markRead(row)"
          >
            {{ t('f1.inbox.markRead') }}
          </el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="kw ? t('common.noMatch') : t('f1.inbox.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('f1.inbox.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
      <template v-if="kw"> · {{ t('common.clientFilter') }}</template>
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('f1.inbox.allLoaded') }}</span>
      <el-button :loading="loading" @click="refresh">{{ t('f1.common.refresh') }}</el-button>
    </template>
  </PageTemplate>

  <el-drawer v-model="drawerOpen" :title="t('f1.inbox.detail')" size="480px" data-test="inbox-drawer">
    <div v-if="current" class="inbox-detail">
      <h3 class="det-title">{{ current.title }}</h3>
      <div class="det-meta">
        <el-tag size="small" round effect="plain" :type="current.readAt ? 'info' : 'warning'">
          {{ current.readAt ? t('f1.inbox.read') : t('f1.inbox.unread') }}
        </el-tag>
        <span class="erp-weak">{{ fmtDateTime(current.createdAt) }}</span>
      </div>
      <div class="det-body">{{ current.body }}</div>
      <div class="det-link">
        <span class="erp-weak">{{ t('f1.inbox.link') }}</span>
        <span class="mono erp-ellipsis" :title="current.link">{{ current.link || t('f1.inbox.noLink') }}</span>
      </div>
    </div>
    <template #footer>
      <el-button @click="drawerOpen = false">{{ t('f1.common.close') }}</el-button>
      <el-button
        v-if="current && !current.readAt"
        type="primary"
        :loading="readBusy === current.id"
        @click="markRead(current)"
      >
        {{ t('f1.inbox.markRead') }}
      </el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.search {
  width: 240px;
}
.err {
  margin-bottom: 12px;
}
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--erp-text-3);
  margin-right: 6px;
  vertical-align: middle;
}
.dot.on {
  background: var(--erp-warning);
}
.title,
.preview {
  min-width: 0;
}
.bold {
  color: var(--erp-text);
  font-weight: 600;
}
.preview {
  line-height: 1.5;
  word-break: break-word;
}
.inbox-detail {
  min-height: 160px;
}
.det-title {
  font-size: 16px;
  margin: 0 0 10px;
  color: var(--erp-text);
  word-break: break-word;
}
.det-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.det-body {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.7;
  color: var(--erp-text-2);
  padding: 12px;
  border: 1px solid var(--erp-border);
  border-radius: var(--erp-radius-sm);
  background: var(--erp-surface-2);
  max-height: 56vh;
  overflow: auto;
}
.det-link {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  min-width: 0;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
  min-width: 0;
}
@media (max-width: 900px) {
  .search {
    width: 100%;
  }
}
</style>
