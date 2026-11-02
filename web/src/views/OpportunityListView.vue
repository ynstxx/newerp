<script setup>
/**
 * 商机列表：搜索 + 阶段筛选；新建 / 编辑走右侧抽屉，推进只渲染后端给的 allowed。
 * 客户下拉与客户名解析都来自 GET /api/parties（一次取 100 条够 M1 用）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown, Search } from '@element-plus/icons-vue'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { dateInput, fmtDateTime, money, shortId, memberName } from '../format.js'

const STAGES = ['new', 'following', 'won', 'lost']

const items = ref([])
const cursor = ref('')
const loading = ref(false)
/** 列表接口失败时留在页面上，表格照旧渲染（不白屏） */
const error = ref('')
const keyword = ref('')
const stage = ref('')

const parties = ref([])
const partyMap = computed(() => new Map(parties.value.map((p) => [p.id, p])))
const partyLabel = (id) => {
  const p = partyMap.value.get(id)
  return p ? `${p.code} ${p.name}` : ''
}
const partyName = (id) => partyMap.value.get(id)?.name ?? (id ? shortId(id) : t('common.none'))

const drawer = ref(false)
const editing = ref(null)
const busy = ref(false)
const advancing = ref('')
const form = reactive({ code: '', name: '', partyId: '', estAmount: '', expectedSignAt: null, ownerId: '', note: '' })

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canCreate = () => has('opportunity:create')
const canUpdate = () => has('opportunity:update')
/** 后端 reason 优先（推进被拒的理由都写在 details.reason 里） */
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)

async function loadParties() {
  try {
    const data = await api.get('/api/parties?limit=100')
    parties.value = data.items ?? []
  } catch {
    // 客户主数据拿不到不影响列表：客户列退化成 id 前缀
  }
}

async function load(reset = false) {
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams()
    if (!reset && cursor.value) qs.set('cursor', cursor.value)
    if (keyword.value.trim()) qs.set('q', keyword.value.trim())
    if (stage.value) qs.set('stage', stage.value)
    const data = await api.get(`/api/opportunities?${qs}`)
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

function openNew() {
  editing.value = null
  Object.assign(form, { code: '', name: '', partyId: '', estAmount: '', expectedSignAt: null, ownerId: '', note: '' })
  drawer.value = true
}

function openEdit(row) {
  editing.value = row
  Object.assign(form, {
    code: row.code ?? '',
    name: row.name ?? '',
    partyId: row.partyId ?? '',
    estAmount: row.estAmount == null ? '' : String(row.estAmount),
    expectedSignAt: dateInput(row.expectedSignAt) || null,
    ownerId: row.ownerId ?? '',
    note: row.note ?? '',
  })
  drawer.value = true
}

async function save() {
  if (!form.name.trim() || !form.partyId || form.estAmount === '') {
    ElMessage.warning(t('common.required'))
    return
  }
  busy.value = true
  try {
    const payload = {
      ...(form.code.trim() ? { code: form.code.trim() } : {}),
      name: form.name.trim(),
      partyId: form.partyId,
      estAmount: Number(form.estAmount),
      expectedSignAt: form.expectedSignAt || null,
      ownerId: form.ownerId || null,
      note: form.note || null,
    }
    if (editing.value) {
      await api.patch(`/api/opportunities/${editing.value.id}`, { ...payload, version: editing.value.version })
    } else {
      await api.post('/api/opportunities', payload)
    }
    ElMessage.success(t('action.saved'))
    drawer.value = false
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    busy.value = false
  }
}

async function advance(row, to) {
  advancing.value = row.id
  try {
    await api.post(`/api/opportunities/${row.id}/advance`, { to })
    ElMessage.success(to === 'won' ? t('oppty.wonTip') : t('action.saved'))
    refresh()
  } catch (err) {
    ElMessage.error(msgOf(err))
  } finally {
    advancing.value = ''
  }
}

onMounted(() => {
  loadParties()
  refresh()
})
</script>

<template>
  <PageTemplate>
    <template #search>
      <el-input
        v-model="keyword"
        :placeholder="t('oppty.search')"
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
      <el-select v-model="stage" clearable :placeholder="t('oppty.stage')" class="stage" @change="refresh">
        <el-option v-for="k in STAGES" :key="k" :value="k" :label="t(`ostatus.${k}`)" />
      </el-select>
    </template>

    <template #actions>
      <el-button v-if="canCreate()" type="primary" data-test="new" @click="openNew">{{ t('oppty.new') }}</el-button>
    </template>

    <el-alert v-if="error" class="err" type="error" :title="error" :closable="false" show-icon />

    <el-table :data="items" v-loading="loading" border data-test="table" @row-dblclick="(row) => canUpdate() && openEdit(row)">
      <el-table-column prop="code" :label="t('oppty.code')" width="150">
        <template #default="{ row }">
          <span class="code erp-ellipsis" :title="row.code">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="name" :label="t('oppty.name')" min-width="190">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="row.name">{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('oppty.party')" min-width="180">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="partyLabel(row.partyId) || partyName(row.partyId)">
            {{ partyName(row.partyId) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column :label="t('oppty.owner')" width="110">
        <template #default="{ row }">
          <span v-if="row.ownerId" class="erp-ellipsis mono" :title="row.ownerId">{{ memberName(row.ownerId) }}</span>
          <span v-else class="erp-weak">{{ t('common.none') }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('oppty.estAmount')" width="140" align="right">
        <template #default="{ row }">
          <span class="erp-ellipsis" :title="String(row.estAmount)">{{ money(row.estAmount) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="t('oppty.stage')" width="110">
        <template #default="{ row }">
          <el-tag size="small" round effect="plain" :type="row.stage === 'won' ? 'success' : row.stage === 'lost' ? 'info' : 'primary'">
            {{ t(`ostatus.${row.stage}`) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column :label="t('oppty.updatedAt')" width="150">
        <template #default="{ row }">
          <span class="erp-weak">{{ fmtDateTime(row.updatedAt) }}</span>
        </template>
      </el-table-column>
      <el-table-column :label="''" width="160" align="right">
        <template #default="{ row }">
          <el-button v-if="canUpdate()" link type="primary" @click="openEdit(row)">{{ t('action.edit') }}</el-button>
          <el-dropdown
            v-if="canUpdate() && row.allowed?.length"
            trigger="click"
            :disabled="advancing === row.id"
            @command="(to) => advance(row, to)"
          >
            <el-button link type="primary" :loading="advancing === row.id">
              {{ t('action.advance') }}<el-icon class="chev"><ArrowDown /></el-icon>
            </el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="to in row.allowed" :key="to" :command="to">
                  {{ t(`ostatus.${to}`) }}
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty :image-size="64" :description="t('oppty.empty')" />
      </template>
    </el-table>

    <template #hint>
      {{ t('oppty.hint') }} · {{ tp('page.loaded', { n: items.length }) }}
    </template>

    <template #pager>
      <el-button v-if="cursor" :loading="loading" @click="load()">{{ t('action.loadMore') }}</el-button>
      <span v-else-if="items.length" class="erp-weak">{{ t('action.noMore') }}</span>
    </template>
  </PageTemplate>

  <el-drawer v-model="drawer" :title="editing ? t('oppty.edit') : t('oppty.new')" size="440px" data-test="oppty-drawer">
    <el-form label-position="top">
      <el-form-item :label="t('oppty.code')" required>
        <el-input v-model="form.code" maxlength="64" data-test="f-code"  placeholder="留空自动生成"/>
      </el-form-item>
      <el-form-item :label="t('oppty.name')" required>
        <el-input v-model="form.name" maxlength="64" data-test="f-name" />
      </el-form-item>
      <el-form-item :label="t('oppty.party')" required>
        <el-select
          v-model="form.partyId"
          filterable
          style="width: 100%"
          :placeholder="parties.length ? t('oppty.partyPick') : t('oppty.partyEmpty')"
          data-test="f-party"
        >
          <el-option v-for="p in parties" :key="p.id" :value="p.id" :label="`${p.code} ${p.name}`" />
        </el-select>
      </el-form-item>
      <el-form-item :label="t('oppty.estAmount')" required>
        <el-input v-model="form.estAmount" type="number" min="0" data-test="f-amount" />
      </el-form-item>
      <el-form-item :label="t('oppty.expectedSignAt')">
        <el-date-picker
          v-model="form.expectedSignAt"
          type="date"
          value-format="YYYY-MM-DD"
          style="width: 100%"
        />
      </el-form-item>
      <el-form-item :label="t('oppty.owner')">
        <el-input v-model="form.ownerId" maxlength="36" :placeholder="t('oppty.ownerHint')" />
      </el-form-item>
      <el-form-item :label="t('oppty.note')">
        <el-input v-model="form.note" type="textarea" :rows="3" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="drawer = false">{{ t('action.cancel') }}</el-button>
      <el-button type="primary" :loading="busy" data-test="f-save" @click="save">{{ t('action.save') }}</el-button>
    </template>
  </el-drawer>
</template>

<style scoped>
.search {
  width: 240px;
}
.stage {
  width: 140px;
}
.err {
  margin-bottom: 12px;
}
.code,
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
}
.chev {
  margin-left: 2px;
}
@media (max-width: 900px) {
  .search,
  .stage {
    width: 100%;
  }
}
</style>
