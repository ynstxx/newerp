<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ArrowDown,
  Bell,
  Calendar,
  Checked,
  Close,
  Coin,
  Document,
  Expand,
  Files,
  Fold,
  Folder,
  MagicStick,
  Memo,
  Message,
  Odometer,
  OfficeBuilding,
  Refresh,
  Search,
  Setting,
  ShoppingCart,
  Tickets,
  Tools,
  TrendCharts,
  User,
  Van,
  Wallet,
} from '@element-plus/icons-vue'
import { t } from './i18n.js'
import { state } from './state.js'

const props = defineProps({
  collapsed: { type: Boolean, default: false },
  /** @type {{ key: string }[]} */
  tabs: { type: Array, default: () => [] },
  active: { type: String, default: '' },
})

const emit = defineEmits(['toggle', 'refresh', 'open', 'close', 'logout', 'switch-tenant', 'toggle-lang', 'search'])

/** 菜单分组：分组标题可折叠 + 子项。成员在 M1 没有界面，置灰但保留位置。 */
const groups = [
  {
    key: 'overview',
    label: 'menu.groupOverview',
    items: [
      { key: 'workbench', label: 'menu.workbench', icon: Odometer },
      { key: 'inbox', label: 'menu.inbox', icon: Bell },
    ],
  },
  {
    key: 'business',
    label: 'menu.groupBusiness',
    items: [
      { key: 'opportunity', label: 'menu.opportunity', icon: TrendCharts },
      { key: 'project', label: 'menu.project', icon: Folder },
      { key: 'party', label: 'menu.party', icon: OfficeBuilding },
    ],
  },
  {
    key: 'commerce',
    label: 'menu.groupCommerce',
    items: [
      { key: 'quotation', label: 'menu.quotation', icon: Tickets },
      { key: 'contract', label: 'menu.contract', icon: Memo },
    ],
  },
  {
    key: 'approval',
    label: 'menu.groupApproval',
    items: [
      { key: 'approvals', label: 'menu.approvals', icon: Checked },
      { key: 'approvalFlows', label: 'menu.approvalFlows', icon: Files },
      { key: 'notifySettings', label: 'menu.notifySettings', icon: Setting },
    ],
  },
  {
    key: 'work',
    label: 'menu.groupWork',
    items: [
      { key: 'workPlans', label: 'menu.workPlans', icon: Calendar },
      { key: 'materialIssues', label: 'menu.materialIssues', icon: Van },
      { key: 'changeOrders', label: 'menu.changeOrders', icon: Document },
      { key: 'acceptances', label: 'menu.acceptances', icon: Checked },
      { key: 'laborHours', label: 'menu.laborHours', icon: Tools },
    ],
  },
  {
    key: 'purchase',
    label: 'menu.groupPurchase',
    items: [
      { key: 'purchaseOrders', label: 'menu.purchaseOrders', icon: ShoppingCart },
      { key: 'goodsReceipts', label: 'menu.goodsReceipts', icon: Van },
      { key: 'subcontracts', label: 'menu.subcontracts', icon: Files },
      { key: 'ledgers', label: 'menu.ledgers', icon: Wallet },
      { key: 'profit', label: 'menu.profit', icon: Coin },
    ],
  },
  {
    key: 'service',
    label: 'menu.groupService',
    items: [
      { key: 'tickets', label: 'menu.tickets', icon: Message },
      { key: 'serviceContracts', label: 'menu.serviceContracts', icon: Memo },
    ],
  },
  {
    key: 'platform',
    label: 'menu.groupPlatform',
    items: [
      { key: 'integrations', label: 'menu.integrations', icon: MagicStick },
      { key: 'aiChat', label: 'menu.aiChat', icon: Message },
      { key: 'aiDrafts', label: 'menu.aiDrafts', icon: Files },
    ],
  },
  {
    key: 'system',
    label: 'menu.groupSystem',
    items: [
      { key: 'settings', label: 'menu.settings', icon: Setting },
      { key: 'member', label: 'menu.member', icon: User, disabled: true },
    ],
  },
]

/** 折叠起来的分组（点标题收合，默认全开） */
const closedGroups = ref(/** @type {string[]} */ ([]))
const toggleGroup = (/** @type {string} */ key) => {
  closedGroups.value = closedGroups.value.includes(key)
    ? closedGroups.value.filter((k) => k !== key)
    : [...closedGroups.value, key]
}
const isClosed = (/** @type {string} */ key) => closedGroups.value.includes(key)

/** < 900px：侧栏强制收成图标条，顶栏精简（CSS 里再做具体退化） */
const narrow = ref(false)
/** @type {MediaQueryList | null} */
let mq = null
const onMq = (/** @type {MediaQueryListEvent} */ e) => {
  narrow.value = e.matches
}
const rail = computed(() => props.collapsed || narrow.value)

const crumbs = computed(() => {
  const group = groups.find((g) => g.items.some((i) => i.key === props.active))
  return [t(group?.label ?? 'menu.groupOverview'), t(`menu.${props.active || 'workbench'}`)]
})

const initial = computed(() => (state.user?.displayName ?? '?').slice(0, 1).toUpperCase())

/** 面包屑第二段以外，顶栏只留最后一级（窄屏） */
const keyword = ref('')
const searchRef = ref(/** @type {any} */ (null))

/** ⌘K / Ctrl+K 聚焦搜索框 —— 徽标是装饰，快捷键两条都认 */
function onKeydown(/** @type {KeyboardEvent} */ e) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    searchRef.value?.focus?.()
  }
}

onMounted(() => {
  mq = window.matchMedia('(max-width: 900px)')
  narrow.value = mq.matches
  mq.addEventListener('change', onMq)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  mq?.removeEventListener('change', onMq)
  window.removeEventListener('keydown', onKeydown)
})

/** @param {string} cmd */
function onCommand(cmd) {
  if (cmd === 'logout') emit('logout')
  else if (cmd === 'lang') emit('toggle-lang')
  else if (cmd.startsWith('t:')) emit('switch-tenant', cmd.slice(2))
}
</script>

<template>
  <div class="shell" :class="{ rail }">
    <aside class="side">
      <div class="brand">
        <div class="logo">N</div>
        <div v-if="!rail" class="brand-text">
          <span class="brand-name">{{ t('app.name') }}</span>
          <span class="brand-sub erp-ellipsis" :title="state.tenant?.name">{{ state.tenant?.name }}</span>
        </div>
      </div>

      <nav class="nav">
        <div v-for="g in groups" :key="g.key" class="grp">
          <button v-if="!rail" class="grp-head" type="button" @click="toggleGroup(g.key)">
            <span class="grp-label">{{ t(g.label) }}</span>
            <el-icon class="chev" :class="{ open: !isClosed(g.key) }"><ArrowDown /></el-icon>
          </button>
          <ul v-show="rail || !isClosed(g.key)" class="items">
            <li v-for="it in g.items" :key="it.key">
              <button
                type="button"
                class="item"
                :class="{ active: it.key === active, off: it.disabled }"
                :disabled="it.disabled"
                :title="rail ? t(it.label) : it.disabled ? t('menu.memberSoon') : ''"
                @click="emit('open', it.key)"
              >
                <span class="bar" />
                <el-icon class="ico"><component :is="it.icon" /></el-icon>
                <template v-if="!rail">
                  <span class="label erp-ellipsis">{{ t(it.label) }}</span>
                  <span v-if="it.disabled" class="soon">{{ t('menu.soon') }}</span>
                </template>
              </button>
            </li>
          </ul>
        </div>
      </nav>

      <div v-if="!rail" class="side-foot">
        <el-button link size="small" @click="emit('toggle-lang')">{{ t('app.lang') }}</el-button>
        <span class="ver erp-weak">M1</span>
      </div>
    </aside>

    <div class="main">
      <header class="top">
        <el-tooltip :content="collapsed ? t('top.unfold') : t('top.fold')" placement="bottom">
          <button class="icon-btn" type="button" :aria-label="t('top.fold')" @click="emit('toggle')">
            <el-icon><component :is="collapsed ? Expand : Fold" /></el-icon>
          </button>
        </el-tooltip>
        <el-tooltip :content="t('top.refresh')" placement="bottom">
          <button class="icon-btn" type="button" :aria-label="t('top.refresh')" @click="emit('refresh')">
            <el-icon><Refresh /></el-icon>
          </button>
        </el-tooltip>

        <div class="crumb">
          <template v-for="(c, i) in crumbs" :key="c">
            <span v-if="i" class="sep">/</span>
            <span class="crumb-item" :class="{ on: i === crumbs.length - 1 }">{{ c }}</span>
          </template>
        </div>

        <div class="spacer" />

        <el-input
          ref="searchRef"
          v-model="keyword"
          class="search"
          :placeholder="t('top.search')"
          clearable
          @keyup.enter="emit('search', keyword)"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
          <template #suffix>
            <span class="kbd">⌘K</span>
          </template>
        </el-input>

        <el-popover placement="bottom-end" :width="260" trigger="click">
          <template #reference>
            <button class="icon-btn" type="button" :aria-label="t('top.notify')">
              <el-badge is-dot :offset="[-2, 2]">
                <el-icon><Bell /></el-icon>
              </el-badge>
            </button>
          </template>
          <div class="pop-head">{{ t('top.notify') }}</div>
          <el-empty :image-size="48" :description="t('top.notifyEmpty')" />
        </el-popover>

        <el-dropdown trigger="click" @command="onCommand">
          <div class="user">
            <el-avatar :size="26" class="user-avatar">{{ initial }}</el-avatar>
            <span class="user-name erp-ellipsis" :title="state.user?.displayName">{{ state.user?.displayName }}</span>
            <el-icon class="caret"><ArrowDown /></el-icon>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item disabled>{{ state.tenant?.name }}</el-dropdown-item>
              <el-dropdown-item
                v-for="x in state.tenants.filter((v) => v.slug !== state.tenant?.slug)"
                :key="x.slug"
                :command="`t:${x.slug}`"
              >
                {{ t('company.switch') }}：{{ x.name }}
              </el-dropdown-item>
              <el-dropdown-item divided command="lang">{{ t('app.lang') }}</el-dropdown-item>
              <el-dropdown-item command="logout">{{ t('top.logout') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </header>

      <div class="tabs">
        <div
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ on: tab.key === active }"
          @click="emit('open', tab.key)"
        >
          <span class="tab-label">{{ t(`menu.${tab.key}`) }}</span>
          <el-icon v-if="tab.key !== 'workbench'" class="tab-x" @click.stop="emit('close', tab.key)">
            <Close />
          </el-icon>
        </div>
      </div>

      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background: var(--erp-bg);
}

/* —— 侧栏 —— */
.side {
  width: var(--erp-side-w);
  flex: 0 0 var(--erp-side-w);
  display: flex;
  flex-direction: column;
  background: var(--erp-surface-2);
  border-right: 1px solid var(--erp-border);
  transition: width 0.16s ease, flex-basis 0.16s ease;
  overflow: hidden;
}
.rail .side {
  width: var(--erp-side-w-collapsed);
  flex-basis: var(--erp-side-w-collapsed);
}
.brand {
  height: var(--erp-top-h);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--erp-border);
  flex: 0 0 var(--erp-top-h);
}
.logo {
  width: 26px;
  height: 26px;
  flex: 0 0 26px;
  border-radius: var(--erp-radius-sm);
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 14px;
  color: #fff;
  background: linear-gradient(135deg, var(--erp-primary), #7a58ff);
}
.brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
.brand-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--erp-text);
}
.brand-sub {
  font-size: 11px;
  color: var(--erp-text-3);
}

.nav {
  flex: 1;
  overflow-y: auto;
  padding: 16px 0 20px;
}
/* 分组之间只比行间(5+5=10px)多一点：14 → 6，避免整栏看着被切成四段 */
.grp + .grp {
  margin-top: 6px;
}
/* 分组头是"可点的一行"，不是一段小字：给它和菜单项一样的命中区与 hover 反馈 */
/* 分组头和菜单项用同一把尺子：同高、同缩进、同圆角、同上下间距 */
.grp-head {
  width: calc(100% - 24px);
  margin: 5px 12px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 12px;
  background: none;
  border: 0;
  border-radius: var(--erp-radius-sm);
  color: var(--erp-text-3);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.grp-head:hover {
  color: var(--erp-text-2);
  background: var(--erp-primary-hover);
}
.grp-head:focus-visible {
  outline: 2px solid var(--erp-primary);
  outline-offset: -2px;
}
.grp-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chev {
  flex: 0 0 auto;
  font-size: 14px;
  transition: transform 0.18s ease;
  transform: rotate(-90deg);
}
.chev.open {
  transform: rotate(0deg);
}

.items {
  list-style: none;
  margin: 0;
  padding: 0;
}

.item {
  position: relative;
  width: calc(100% - 24px);
  margin: 5px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--erp-radius-sm);
  background: transparent;
  color: var(--erp-text-2);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.item:hover {
  background: var(--erp-primary-hover);
  color: var(--erp-text);
}
.item .bar {
  position: absolute;
  left: -12px;
  top: 11px;
  bottom: 11px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: transparent;
}
.item.active {
  background: var(--erp-primary-soft);
  color: var(--erp-text);
}
.item.active .bar {
  background: var(--erp-primary);
}
.item.active .ico {
  color: var(--erp-primary);
}
.item.off {
  color: var(--erp-text-3);
  cursor: not-allowed;
}
.item.off:hover {
  background: transparent;
  color: var(--erp-text-3);
}
.ico {
  font-size: 18px;
  flex: 0 0 18px;
}
.label {
  flex: 1;
  min-width: 0;
}
.soon {
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 6px;
  color: var(--erp-text-3);
  border: 1px solid var(--erp-border);
}
.rail .item {
  width: 44px;
  margin: 6px auto;
  padding: 0;
  justify-content: center;
}
.rail .item .bar {
  left: -12px;
}
.side-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 1px solid var(--erp-border);
}

/* —— 主区 —— */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.top {
  height: var(--erp-top-h);
  flex: 0 0 var(--erp-top-h);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
  background: var(--erp-surface);
  border-bottom: 1px solid var(--erp-border);
}
.icon-btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--erp-radius-sm);
  background: transparent;
  color: var(--erp-text-2);
  font-size: 15px;
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--erp-primary-hover);
  color: var(--erp-text);
}
.crumb {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
  font-size: 12px;
  color: var(--erp-text-3);
  min-width: 0;
}
.crumb-item.on {
  color: var(--erp-text-2);
}
.spacer {
  flex: 1;
}
.search {
  width: 220px;
}
.search :deep(.el-input__wrapper) {
  background: var(--erp-surface-2);
  box-shadow: none;
  border: 1px solid var(--erp-border);
}
.search :deep(.el-input__wrapper.is-focus) {
  border-color: rgba(79, 124, 255, 0.55);
}
.kbd {
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 5px;
  color: var(--erp-text-3);
  border: 1px solid var(--erp-border);
  background: rgba(255, 255, 255, 0.03);
}
.search :deep(.el-input__suffix) {
  margin-left: 6px;
}
.user {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border-radius: var(--erp-radius-sm);
  cursor: pointer;
  color: var(--erp-text-2);
}
.user:hover {
  background: var(--erp-primary-hover);
}
.user-avatar {
  background: rgba(79, 124, 255, 0.2);
  color: #cfd9ff;
  font-size: 12px;
}
.user-name {
  max-width: 110px;
  font-size: 12px;
  color: var(--erp-text);
}
.caret {
  font-size: 10px;
  color: var(--erp-text-3);
}
.pop-head {
  font-size: 12px;
  color: var(--erp-text-2);
  padding-bottom: 6px;
}

/* —— 页签行 —— */
.tabs {
  height: var(--erp-tabs-h);
  flex: 0 0 var(--erp-tabs-h);
  display: flex;
  align-items: stretch;
  gap: 0;
  padding: 0 8px;
  background: var(--erp-surface);
  border-bottom: 1px solid var(--erp-border);
  overflow-x: auto;
  overflow-y: hidden;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  max-width: 200px;
  font-size: 12px;
  color: var(--erp-text-3);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.tab:hover {
  color: var(--erp-text-2);
  background: var(--erp-primary-hover);
}
.tab.on {
  color: var(--erp-text);
  border-bottom-color: var(--erp-primary);
  background: rgba(79, 124, 255, 0.07);
}
.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-x {
  font-size: 11px;
  border-radius: 50%;
  padding: 1px;
  opacity: 0;
}
.tab:hover .tab-x,
.tab.on .tab-x {
  opacity: 0.7;
}
.tab-x:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.12);
}

/* —— 内容区 —— */
.content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--erp-gap);
}

/* —— 窄屏（< 900px）：侧栏只留图标、顶栏去掉搜索与用户名 —— */
@media (max-width: 900px) {
  .search,
  .crumb,
  .user-name {
    display: none;
  }
  .side-foot {
    padding: 8px;
  }
}
</style>
