<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, fieldErrors } from '../api.js'
import { t } from '../i18n.js'
import { state } from '../state.js'
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
  <div>
    <div class="head">
      <strong>{{ t('party.title') }}</strong>
      <div class="spacer" />
      <el-input
        v-model="keyword"
        :placeholder="t('party.search')"
        clearable
        style="width: 220px"
        data-test="search"
        @keyup.enter="refresh"
        @clear="refresh"
      />
      <el-select v-model="partyType" clearable :placeholder="t('party.type')" style="width: 140px" @change="refresh">
        <el-option v-for="k in ['customer', 'supplier', 'both']" :key="k" :value="k" :label="t(`type.${k}`)" />
      </el-select>
      <el-button type="primary" data-test="new" @click="openNew">{{ t('party.new') }}</el-button>
    </div>

    <el-table :data="items" v-loading="loading" border stripe empty-text=" " data-test="table" @row-dblclick="openEdit">
      <el-table-column prop="code" :label="t('party.code')" width="140" />
      <el-table-column prop="name" :label="t('party.name')" min-width="180" />
      <el-table-column :label="t('party.type')" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="row.partyType === 'customer' ? 'success' : row.partyType === 'supplier' ? 'warning' : 'info'">
            {{ t(`type.${row.partyType}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('party.status')" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'primary' : 'info'" effect="plain">
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
    </el-table>

    <div v-if="!loading && !items.length" class="empty">{{ t('party.empty') }}</div>

    <div class="foot">
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('party.loadMore') }}</el-button>
      <span v-else-if="items.length" class="muted">{{ t('party.noMore') }}</span>
    </div>

    <PartyForm v-model="drawer" :party="editing" @saved="refresh" />
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.head .spacer {
  flex: 1;
}
.foot {
  margin-top: 12px;
  text-align: center;
}
.empty {
  padding: 24px;
  text-align: center;
  color: #909399;
}
.muted {
  color: #c0c4cc;
  font-size: 12px;
}
</style>
