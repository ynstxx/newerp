<script setup>
/**
 * 项目毛利：选项目 → GET /api/projects/:id/profit。
 * revenue / cost / gross 都来自后端（按分算完再转数字），页面只负责展示与对比条。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t } from '../i18n.js'
import PageTemplate from '../components/PageTemplate.vue'
import { money, shortId } from '../format.js'

const projects = ref([])
const projectId = ref('')
const profit = ref(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')

const projectMap = computed(() => new Map(projects.value.map((p) => [p.id, p])))
const selectedProject = computed(() => projectMap.value.get(projectId.value) ?? null)
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

const maxValue = computed(() => {
  if (!profit.value) return 0
  return Math.max(Number(profit.value.revenue) || 0, Number(profit.value.cost) || 0, 0)
})

const bars = computed(() => {
  const max = maxValue.value
  const revenue = Number(profit.value?.revenue) || 0
  const cost = Number(profit.value?.cost) || 0
  return [
    {
      key: 'revenue',
      label: t('f3.profit.revenue'),
      value: revenue,
      pct: max > 0 ? Math.max(2, Math.round((revenue / max) * 100)) : 0,
      color: 'var(--erp-primary)',
    },
    {
      key: 'cost',
      label: t('f3.profit.cost'),
      value: cost,
      pct: max > 0 ? Math.max(2, Math.round((cost / max) * 100)) : 0,
      color: 'var(--erp-warning)',
    },
  ]
})

const rateText = computed(() => {
  const rate = profit.value?.grossRate
  if (rate === null || rate === undefined) return t('common.none')
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 2 }).format(Number(rate))
})

async function loadProjects() {
  try {
    const data = await api.get('/api/projects?limit=100')
    projects.value = data.items ?? []
    if (!projectId.value && projects.value.length) {
      projectId.value = projects.value[0].id
      await loadProfit()
    }
  } catch (err) {
    error.value = msgOf(err)
    ElMessage.error(error.value)
  }
}

async function loadProfit() {
  if (!projectId.value) {
    profit.value = null
    loaded.value = false
    return
  }
  loading.value = true
  error.value = ''
  try {
    profit.value = await api.get(`/api/projects/${projectId.value}/profit`)
    loaded.value = true
  } catch (err) {
    error.value = msgOf(err)
    profit.value = null
    loaded.value = true
    ElMessage.error(error.value)
  } finally {
    loading.value = false
  }
}

function refresh() {
  loadProfit()
}

onMounted(() => {
  loadProjects()
})
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-select
        v-model="projectId"
        clearable
        filterable
        :placeholder="t('f3.profit.projectPick')"
        class="project"
        data-test="project-pick"
        @change="loadProfit"
      >
        <el-option v-for="p in projects" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
      </el-select>
    </template>

    <template #actions>
      <el-button :icon="Refresh" :loading="loading" :disabled="!projectId" @click="refresh">
        {{ t('f3.profit.refresh') }}
      </el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <div v-loading="loading" class="profit-body">
      <el-empty v-if="!projectId" :image-size="72" :description="t('f3.profit.notSelected')" />
      <el-empty v-else-if="loaded && !profit && !error" :image-size="64" :description="t('f3.profit.empty')" />

      <template v-else-if="profit">
        <div class="proj-head">
          <span class="code">{{ selectedProject?.code ?? shortId(projectId) }}</span>
          <span class="erp-ellipsis" :title="selectedProject?.name">{{ selectedProject?.name }}</span>
        </div>

        <el-descriptions :column="2" border size="default">
          <el-descriptions-item :label="t('f3.profit.revenue')">
            <span class="num">{{ money(profit.revenue) }}</span>
          </el-descriptions-item>
          <el-descriptions-item :label="t('f3.profit.cost')">
            <span class="num">{{ money(profit.cost) }}</span>
          </el-descriptions-item>
          <el-descriptions-item :label="t('f3.profit.gross')">
            <span class="num" :class="Number(profit.gross) < 0 ? 'negative' : 'positive'">
              {{ money(profit.gross) }}
            </span>
          </el-descriptions-item>
          <el-descriptions-item :label="t('f3.profit.grossRate')">
            <span class="num" :class="Number(profit.gross) < 0 ? 'negative' : 'positive'">{{ rateText }}</span>
          </el-descriptions-item>
        </el-descriptions>

        <div class="bar-card">
          <div class="sec-head">
            <span class="erp-card-title">{{ t('f3.profit.barTitle') }}</span>
            <span class="erp-weak">{{ t('f3.profit.barHint') }}</span>
          </div>
          <div v-for="bar in bars" :key="bar.key" class="bar-row">
            <span class="bar-label">{{ bar.label }}</span>
            <div class="bar-track">
              <div class="bar-fill" :style="{ width: bar.pct + '%', background: bar.color }" />
            </div>
            <span class="bar-value">{{ money(bar.value) }}</span>
          </div>
        </div>

        <div class="erp-weak foot-note">{{ t('f3.profit.hint') }}</div>
      </template>
    </div>
  </PageTemplate>
</template>

<style scoped>
.project {
  width: 300px;
}
.err {
  margin-bottom: 12px;
}
.profit-body {
  min-height: 160px;
}
.proj-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
  min-width: 0;
}
.code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.num {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.positive {
  color: var(--erp-success);
}
.negative {
  color: var(--erp-danger);
}
.bar-card {
  margin-top: var(--erp-gap);
  padding: 16px;
  border: 1px solid var(--erp-border);
  border-radius: var(--erp-radius-sm);
  background: var(--erp-surface-2);
}
.sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
}
.bar-label {
  width: 64px;
  flex: none;
  color: var(--erp-text-2);
}
.bar-track {
  flex: 1;
  height: 14px;
  border-radius: 7px;
  background: var(--erp-surface-3);
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 7px;
  transition: width 0.2s ease;
}
.bar-value {
  width: 140px;
  flex: none;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.foot-note {
  margin-top: 10px;
}
@media (max-width: 900px) {
  .project {
    width: 100%;
  }
  .bar-row {
    flex-wrap: wrap;
  }
  .bar-track {
    flex-basis: 100%;
    order: 3;
  }
  .bar-value {
    width: auto;
    margin-left: auto;
  }
}
</style>
