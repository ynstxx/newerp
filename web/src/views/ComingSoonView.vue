<script setup>
import { computed } from 'vue'
import { t, tp } from '../i18n.js'

const props = defineProps({
  /** 菜单 key：opportunity / project / quotation / contract */
  name: { type: String, required: true },
})
const emit = defineEmits(['open'])

/** 每个模块的后端接口（已就绪但界面未做），写在页面上比藏起来诚实 */
const API = /** @type {Record<string, string>} */ ({
  opportunity: 'GET /api/opportunities',
  project: 'GET /api/projects',
  quotation: 'GET /api/quotations',
  contract: 'GET /api/contracts',
})
const endpoint = computed(() => API[props.name] ?? '')
</script>

<template>
  <section class="erp-card">
    <el-result icon="info" :title="t(`menu.${name}`)" :sub-title="tp('soon.desc', { name: t(`menu.${name}`) })">
      <template #extra>
        <div class="api erp-weak">{{ endpoint }}</div>
        <el-button type="primary" @click="emit('open', 'workbench')">{{ t('soon.back') }}</el-button>
      </template>
    </el-result>
  </section>
</template>

<style scoped>
.api {
  margin-bottom: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
