<script setup>
import { computed, onMounted, ref } from 'vue'
import {
  Folder,
  Memo,
  Odometer,
  OfficeBuilding,
  Tickets,
  TrendCharts,
} from '@element-plus/icons-vue'
import { api } from '../api.js'
import { i18n, t, tp } from '../i18n.js'
import { state } from '../state.js'

const emit = defineEmits(['open'])

/** @typedef {{ counts: { project: number, opportunity: number, quotation: number, contract: number }, contractAmount: string, recentStages: any[], todos: any[] }} Overview */

const data = ref(/** @type {Overview | null} */ (null))
const projects = ref(/** @type {any[]} */ ([]))
const loading = ref(true)
/** 致命错误：项目列表都拿不到，页面只剩错误说明 */
const error = ref(/** @type {any} */ (null))
/** 局部降级：聚合接口挂了（404/500），项目区照样能用 */
const overviewErr = ref(/** @type {any} */ (null))

const locale = computed(() => (i18n.lang === 'zh' ? 'zh-CN' : 'en-US'))
const fmtDate = (/** @type {unknown} */ v) =>
  v ? new Date(String(v)).toLocaleDateString(locale.value, { year: 'numeric', month: '2-digit', day: '2-digit' }) : '—'
const fmtDateTime = (/** @type {unknown} */ v) =>
  v
    ? new Date(String(v)).toLocaleString(locale.value, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
const money = (/** @type {unknown} */ v) =>
  `¥${new Intl.NumberFormat(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v ?? 0))}`

const today = computed(() =>
  new Date().toLocaleDateString(locale.value, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }),
)
const initial = computed(() => (state.user?.displayName ?? '?').slice(0, 1).toUpperCase())

/** 三个统计：项目 / 商机 / 合同总额 */
const stats = computed(() => [
  { key: 'project', label: 'dash.statProjects', value: data.value ? String(data.value.counts.project) : '—' },
  { key: 'opportunity', label: 'dash.statOpportunities', value: data.value ? String(data.value.counts.opportunity) : '—' },
  { key: 'amount', label: 'dash.statContractAmount', value: data.value ? money(data.value.contractAmount) : '—' },
])

const quick = [
  { key: 'workbench', label: 'menu.workbench', icon: Odometer },
  { key: 'opportunity', label: 'menu.opportunity', icon: TrendCharts },
  { key: 'project', label: 'menu.project', icon: Folder },
  { key: 'party', label: 'menu.party', icon: OfficeBuilding },
  { key: 'quotation', label: 'menu.quotation', icon: Tickets },
  { key: 'contract', label: 'menu.contract', icon: Memo },
]

/** 项目状态 → el-tag 语义色 */
const TAG = /** @type {Record<string, 'primary'|'success'|'warning'|'info'|'danger'>} */ ({
  draft: 'info',
  approved: 'primary',
  designing: 'primary',
  quoting: 'warning',
  signed: 'success',
  terminated: 'danger',
})
const tagType = (/** @type {string} */ s) => TAG[s] ?? 'info'

/** @param {any} s */
const stageDot = (s) => (s.toStatus === 'signed' ? 'var(--erp-success)' : 'var(--erp-primary)')

async function load() {
  loading.value = true
  error.value = null
  overviewErr.value = null
  const [ov, pj] = await Promise.allSettled([
    api.get('/api/workbench'),
    api.get('/api/projects?limit=4'),
  ])

  if (pj.status === 'fulfilled') {
    projects.value = pj.value.items ?? []
  } else {
    // 项目列表是页面的骨架，它挂了才算致命；401（会话过期）不走白屏而是给说明
    error.value = pj.reason
  }
  if (ov.status === 'fulfilled') {
    data.value = /** @type {Overview} */ (ov.value)
  } else {
    overviewErr.value = ov.reason
  }
  loading.value = false
}

const errText = computed(() => {
  const err = error.value ?? overviewErr.value
  if (!err) return ''
  if (err.status === 401) return t('dash.sessionExpired')
  return err.message || t('dash.error')
})

onMounted(load)
</script>

<template>
  <div class="dash">
    <!-- 首次加载：骨架顶住布局，不闪空白 -->
    <template v-if="loading && !data">
      <section class="erp-card"><el-skeleton animated :rows="2" /></section>
      <section class="erp-card">
        <el-skeleton animated :rows="1" />
        <div class="grid3 skel">
          <div v-for="i in 3" :key="i" class="pcard"><el-skeleton animated :rows="3" /></div>
        </div>
      </section>
      <div class="two">
        <section class="erp-card"><el-skeleton animated :rows="4" /></section>
        <section class="erp-card"><el-skeleton animated :rows="4" /></section>
      </div>
    </template>

    <!-- 接口挂了：给错误说明与重试，页面框架照旧 -->
    <section v-else-if="error" class="erp-card">
      <el-result icon="warning" :title="t('dash.error')" :sub-title="errText">
        <template #extra>
          <el-button type="primary" @click="load">{{ t('dash.retry') }}</el-button>
        </template>
      </el-result>
    </section>

    <template v-else>
      <!-- 1 · 欢迎卡 -->
      <section class="erp-card welcome" v-loading="loading">
        <div class="who">
          <el-avatar :size="56" class="avatar">{{ initial }}</el-avatar>
          <div class="who-text">
            <div class="hello erp-ellipsis" :title="tp('dash.greet', { name: state.user?.displayName ?? '' })">
              {{ tp('dash.greet', { name: state.user?.displayName ?? '' }) }}
            </div>
            <div class="meta">
              <el-icon class="meta-ico"><OfficeBuilding /></el-icon>
              <span class="company erp-ellipsis" :title="state.tenant?.name">{{ state.tenant?.name }}</span>
              <span class="sep">·</span>
              <span class="erp-weak">{{ today }}</span>
            </div>
          </div>
        </div>
        <div class="stats">
          <div v-for="s in stats" :key="s.key" class="stat">
            <div class="stat-value erp-ellipsis" :title="String(s.value)">{{ s.value }}</div>
            <div class="stat-label">{{ t(s.label) }}</div>
          </div>
        </div>
      </section>

      <el-alert
        v-if="overviewErr && !error"
        class="banner"
        type="warning"
        :closable="false"
        show-icon
        :title="t('dash.partialTitle')"
        :description="errText"
      />

      <!-- 2 · 项目卡片网格 -->
      <section class="erp-card">
        <div class="erp-card-head">
          <span class="erp-card-title">{{ t('dash.projects') }}</span>
          <div class="spacer" />
          <el-button link type="primary" size="small" @click="emit('open', 'project')">
            {{ t('dash.more') }}
          </el-button>
        </div>
        <div v-if="projects.length" class="grid3" v-loading="loading">
          <article v-for="p in projects" :key="p.id" class="pcard">
            <div class="pcard-top">
              <span class="pcode erp-ellipsis" :title="p.code">{{ p.code }}</span>
              <el-tag size="small" :type="tagType(p.status)" effect="dark" round>{{ t(`pstatus.${p.status}`) }}</el-tag>
            </div>
            <div class="pname erp-clamp-2" :title="p.name">{{ p.name }}</div>
            <div class="pfoot">
              <span class="pamt">{{ money(p.contractAmt) }}</span>
              <span class="erp-weak" :title="fmtDateTime(p.createdAt)">{{ fmtDate(p.createdAt) }}</span>
            </div>
          </article>
        </div>
        <el-empty v-else :image-size="64" :description="t('dash.projectEmpty')">
          <el-button size="small" @click="emit('open', 'opportunity')">{{ t('dash.goOpportunity') }}</el-button>
        </el-empty>
      </section>

      <!-- 3 · 快捷导航 6 宫格 -->
      <section class="erp-card">
        <div class="erp-card-head">
          <span class="erp-card-title">{{ t('dash.quick') }}</span>
        </div>
        <div class="quick">
          <button
            v-for="q in quick"
            :key="q.key"
            type="button"
            class="quick-item"
            :class="{ on: q.key === 'workbench' }"
            @click="emit('open', q.key)"
          >
            <el-icon class="quick-ico"><component :is="q.icon" /></el-icon>
            <span class="quick-label erp-ellipsis">{{ t(q.label) }}</span>
          </button>
        </div>
      </section>

      <div class="two">
        <!-- 4 · 最近动态 -->
        <section class="erp-card">
          <div class="erp-card-head">
            <span class="erp-card-title">{{ t('dash.recent') }}</span>
          </div>
          <div v-if="overviewErr" class="erp-weak">{{ errText }}</div>
          <el-timeline v-else-if="data?.recentStages.length" class="timeline">
            <el-timeline-item
              v-for="s in data.recentStages"
              :key="`${s.projectId}-${s.at}-${s.toStatus}`"
              :timestamp="fmtDateTime(s.at)"
              :color="stageDot(s)"
              placement="top"
            >
              <div class="ev">
                <span class="ev-name erp-ellipsis" :title="s.projectName">{{ s.projectName }}</span>
                <span class="ev-code erp-weak">{{ s.projectCode }}</span>
              </div>
              <div class="ev-flow erp-muted">
                <template v-if="s.fromStatus">{{ t(`pstatus.${s.fromStatus}`) }} → </template>
                <span class="ev-to">{{ t(`pstatus.${s.toStatus}`) }}</span>
              </div>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-else :image-size="64" :description="t('dash.recentEmpty')" />
        </section>

        <!-- 5 · 待办：报价中的项目 = 待签约 -->
        <section class="erp-card">
          <div class="erp-card-head">
            <span class="erp-card-title">{{ t('dash.todos') }}</span>
            <el-tag v-if="data?.todos.length" size="small" effect="plain" type="warning">{{ data.todos.length }}</el-tag>
          </div>
          <div v-if="overviewErr" class="erp-weak">{{ errText }}</div>
          <ul v-else-if="data?.todos.length" class="todo-list">
            <li v-for="x in data.todos" :key="x.projectId" class="todo" @click="emit('open', 'project')">
              <div class="todo-main">
                <span class="todo-name erp-ellipsis" :title="x.name">{{ x.name }}</span>
                <span class="erp-weak">{{ x.code }}</span>
              </div>
              <div class="todo-side">
                <el-tag size="small" type="warning" effect="dark" round>{{ t('dash.todoSign') }}</el-tag>
                <span class="erp-weak">{{ fmtDateTime(x.updatedAt) }}</span>
              </div>
            </li>
          </ul>
          <el-empty v-else :image-size="64" :description="t('dash.todosEmpty')" />
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: var(--erp-gap);
}
.banner {
  border-radius: var(--erp-radius-card);
}
.spacer {
  flex: 1;
}

/* 1 欢迎卡 */
.welcome {
  display: flex;
  align-items: center;
  gap: var(--erp-gap);
  flex-wrap: wrap;
}
.who {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
  flex: 1 1 260px;
}
.avatar {
  flex: 0 0 56px;
  font-size: 20px;
  font-weight: 600;
  color: #cfd9ff;
  background: rgba(79, 124, 255, 0.18);
  border: 1px solid rgba(79, 124, 255, 0.35);
}
.who-text {
  min-width: 0;
}
.hello {
  font-size: 18px;
  font-weight: 600;
  color: var(--erp-text);
}
.meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 13px;
  color: var(--erp-text-2);
  min-width: 0;
}
.meta-ico {
  font-size: 13px;
  color: var(--erp-text-3);
}
.company {
  max-width: 220px;
  color: var(--erp-text-2);
}
.sep {
  color: var(--erp-text-3);
}
.stats {
  display: flex;
  gap: 8px;
  flex: 0 1 auto;
}
.stat {
  min-width: 110px;
  padding: 10px 14px;
  border-radius: var(--erp-radius-sm);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--erp-border);
}
.stat-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--erp-text);
}
.stat-label {
  margin-top: 2px;
  font-size: 13px;
  color: var(--erp-text-3);
}

/* 2 项目网格 */
.grid3 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--erp-gap);
}
.grid3.skel {
  margin-top: 12px;
}
.pcard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: var(--erp-radius-card);
  background: rgba(255, 255, 255, 0.025);
  border: 1px solid var(--erp-border);
  transition: border-color 0.16s ease, transform 0.16s ease;
}
.pcard:hover {
  border-color: rgba(79, 124, 255, 0.45);
}
.pcard-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pcode {
  flex: 1;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--erp-text-3);
}
.pname {
  min-height: 40px;
  font-size: 14px;
  color: var(--erp-text);
}
.pfoot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
.pamt {
  color: var(--erp-text);
  font-weight: 600;
}

/* 3 快捷导航 */
.quick {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
}
.quick-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 16px 8px;
  border-radius: var(--erp-radius-sm);
  border: 1px solid var(--erp-border);
  background: rgba(255, 255, 255, 0.025);
  color: var(--erp-text-2);
  font-size: 13px;
  cursor: pointer;
}
.quick-item:hover {
  color: var(--erp-text);
  border-color: rgba(79, 124, 255, 0.45);
  background: var(--erp-primary-soft);
}
.quick-ico {
  font-size: 20px;
  color: var(--erp-primary);
}
.quick-label {
  max-width: 100%;
}

/* 4/5 两列 */
.two {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: var(--erp-gap);
}
.timeline {
  padding: 2px 0 0 2px;
  max-height: 320px;
  overflow-y: auto;
}
.timeline :deep(.el-timeline-item__timestamp) {
  color: var(--erp-text-3);
  font-size: 13px;
}
.ev {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.ev-name {
  font-size: 13px;
  color: var(--erp-text);
  max-width: 60%;
}
.ev-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.ev-flow {
  margin-top: 2px;
  font-size: 13px;
}
.ev-to {
  color: var(--erp-text-2);
}
.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.todo {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--erp-radius-sm);
  border: 1px solid var(--erp-border);
  background: rgba(255, 255, 255, 0.025);
  cursor: pointer;
}
.todo:hover {
  border-color: rgba(79, 124, 255, 0.45);
}
.todo-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.todo-name {
  font-size: 13px;
  color: var(--erp-text);
}
.todo-side {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

/* —— 窄屏：网格降为 1 列，统计条换行 —— */
@media (max-width: 1100px) {
  .quick {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 900px) {
  .grid3,
  .two {
    grid-template-columns: minmax(0, 1fr);
  }
  .stats {
    width: 100%;
  }
  .stat {
    flex: 1 1 0;
    min-width: 0;
  }
  .company {
    max-width: 140px;
  }
}
</style>
