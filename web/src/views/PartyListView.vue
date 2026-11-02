<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, fieldErrors } from '../api.js'
import { Search } from '@element-plus/icons-vue'
import { t } from '../i18n.js'
import { state, dict, dictKey } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import PartyForm from './PartyForm.vue'

const items = ref([])
const cursor = ref('')
const loading = ref(false)
const keyword = ref('')
const partyType = ref('')
const drawer = ref(false)
const editing = ref(null)

const canDelete = () => state.perms.includes('*') || state.perms.includes('party:delete')

async function load(reset = false) {
  loading.value = true
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    if (keyword.value.trim()) qs.set('q', keyword.value.trim())
    if (partyType.value) qs.set('partyType', partyType.value)
    const data = await api.get(`/api/parties?${qs}`)
    items.value = reset ? data.items : [...items.value, ...data.items]
    cursor.value = data.nextCursor ?? ''
  } catch (err) {
    ElMessage.error(fieldErrors(err))
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
  drawer.value = true
}

function openEdit(row) {
  editing.value = row
  drawer.value = true
}

async function remove(row) {
  try {
    await ElMessageBox.confirm(t('party.confirmDelete'), { type: 'warning' })
  } catch {
    return
  }
  try {
    await api.del(`/api/parties/${row.id}`)
    ElMessage.success(t('party.deleted'))
    refresh()
  } catch (err) {
    ElMessage.error(fieldErrors(err))
  }
}

onMounted(refresh)
</script>

<template>
  <PageTemplate>
    <!-- 左上：搜索与筛选 -->
    <template #search>
      <el-input
        v-model="keyword"
        :placeholder="t('party.search')"
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
      <el-select v-model="partyType" clearable :placeholder="t('party.type')" class="type" @change="refresh">
        <el-option v-for="k in dict('partyType')" :key="k" :value="k" :label="t(dictKey('partyType', k))" />
      </el-select>
    </template>

    <!-- 右上：功能按钮 -->
    <template #actions>
      <el-button type="primary" data-test="new" @click="openNew">{{ t('party.new') }}</el-button>
    </template>

    <!-- 中间：列表框 -->
    <el-table :data="items" v-loading="loading" border empty-text=" " data-test="table" @row-dblclick="openEdit">
      <el-table-column prop="code" :label="t('party.code')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" :label="t('party.name')" min-width="200">
        <template #default="{ row }">
          <span class="erp-ellipsis name" :title="row.name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('party.type')" width="110">
        <template #default="{ row }">
          <el-tag size="small" effect="dark" round :type="row.partyType === 'customer' ? 'success' : row.partyType === 'supplier' ? 'warning' : 'info'">
            {{ t(`type.${row.partyType}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('party.status')" width="96">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'primary' : 'info'" effect="plain" round>
            {{ t(`status.${row.status}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="contactName" :label="t('party.contact')" width="110" />
      <el-table-column prop="phone" :label="t('party.phone')" width="140" />
      <el-table-column :label="''" width="150" align="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">{{ t('party.edit') }}</el-button>
          <el-button v-if="canDelete()" link type="danger" @click="remove(row)">{{ t('party.delete') }}</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('party.empty')" />
      </template>
    </el-table>

    <!-- 左下：提示文本 -->
    <template #hint>
      {{ t('party.hint') }} · {{ t('page.loaded', { n: items.length }) }}
      {{ cursor ? '' : ` · ${t('party.noMore')}` }}
    </template>

    <!-- 右下：分页 -->
    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('party.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('party.noMore') }}</span>
    </template>

    <PartyForm v-model="drawer" :party="editing" @saved="refresh" />
  </PageTemplate>
</template>

<style scoped>
.search {
  width: 220px;
}
.type {
  width: 140px;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.name {
  color: var(--erp-text);
}
@media (max-width: 900px) {
  .search,
  .type {
    width: 100%;
  }
}
</style>
