<script setup>
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, fieldErrors } from '../api.js'
import { t } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'

/**
 * 系统设置：租户自己的开关。开关项由后端返回（type/label 都由接口给），
 * 前端不硬编码配置项清单 —— 后端加一项这里自动出现。
 */
/** @type {import('vue').Ref<{ key: string, value: string, type: string, label: string, labelEn: string }[]>} */
const items = ref([])
const loading = ref(false)
const err = ref('')
const saving = ref('')

const canConfig = computed(() => state.perms.includes('*') || state.perms.includes('system:config'))

async function load() {
  loading.value = true
  err.value = ''
  try {
    items.value = (await api.get('/api/configs')).items ?? []
  } catch (e) {
    err.value = e?.details?.reason ?? fieldErrors(e)
  } finally {
    loading.value = false
  }
}

/** @param {string} key @param {boolean} next */
async function toggle(key, next) {
  saving.value = key
  try {
    await api.put(`/api/configs/${key}`, { value: next ? 'true' : 'false' })
    const row = items.value.find((x) => x.key === key)
    if (row) row.value = next ? 'true' : 'false'
    ElMessage.success(t('sys.saved'))
  } catch (e) {
    ElMessage.error(e?.details?.reason ?? fieldErrors(e))
    await load()
  } finally {
    saving.value = ''
  }
}

const label = (/** @type {any} */ row) => (t('app.lang') === 'EN' ? row.labelEn : row.label)
const on = (/** @type {any} */ row) => row.value !== 'false'

onMounted(load)
</script>

<template>
  <PageTemplate>
    <template #search>
      <span class="erp-weak">{{ t('sys.hint') }}</span>
    </template>

    <div v-if="err" class="err">
      <el-alert :title="err" type="error" :closable="false" show-icon />
    </div>

    <el-table :data="items" v-loading="loading" border empty-text=" ">
      <el-table-column :label="t('sys.item')" min-width="240">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="label(row)">{{ label(row) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('sys.key')" width="160">
        <template #default="{ row }">
          <span class="mono">{{ row.key }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('sys.value')" width="120">
        <template #default="{ row }">
          <el-switch
            :model-value="on(row)"
            :disabled="!canConfig || saving === row.key"
            :loading="saving === row.key"
            @update:model-value="(v) => toggle(row.key, Boolean(v))"
          />
        </template>
      </el-table-column>
      <el-table-column :label="t('sys.effect')" min-width="200">
        <template #default="{ row }">
          <span class="erp-weak">{{
            row.key === 'code.auto'
              ? on(row)
                ? t('sys.codeAutoOn')
                : t('sys.codeAutoOff')
              : ''
          }}</span>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('sys.empty')" />
      </template>
    </el-table>

    <template #hint>{{ t('sys.footHint') }}</template>

    <template #pager>
      <el-button :loading="loading" @click="load">{{ t('sys.refresh') }}</el-button>
    </template>
  </PageTemplate>
</template>

<style scoped>
.err {
  margin-bottom: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
</style>
