<script setup>
/**
 * AI 对话：一次 POST /api/ai/chat，返回 reply + 可选 draft。
 * 未配置模型时后端 503，reason 直接显示在聊天区顶部 —— 绝不白屏。
 * 发送前只把 user/assistant 消息回传，草稿卡片不进上下文。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api, fieldErrors } from '../api.js'
import { t, tp } from '../i18n.js'
import { state } from '../state.js'
import PageTemplate from '../components/PageTemplate.vue'
import { shortId } from '../format.js'

const messages = ref([])
const input = ref('')
const sending = ref(false)
const error = ref('')
const stream = ref(null)

const has = (perm) => state.perms.includes('*') || state.perms.includes(perm)
const canChat = () => has('ai:chat')
const msgOf = (err) => err?.details?.reason ?? fieldErrors(err)
const turns = computed(() => messages.value.filter((m) => m.role === 'user' || m.role === 'assistant').length)
const history = computed(() =>
  messages.value
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content })),
)
const pretty = (v) => JSON.stringify(v ?? null, null, 2)
const isDiff = (preview) => Array.isArray(preview?.diff) && preview.diff.length > 0

async function scrollBottom() {
  await nextTick()
  const el = stream.value
  if (el) el.scrollTop = el.scrollHeight
}

async function send() {
  if (!canChat() || sending.value) return
  const text = input.value.trim()
  if (!text) {
    ElMessage.warning(t('f4.chat.inputRequired'))
    return
  }
  error.value = ''
  sending.value = true
  await scrollBottom()
  try {
    const data = await api.post('/api/ai/chat', { messages: [...history.value, { role: 'user', content: text }] })
    messages.value.push({ role: 'user', content: text })
    if (data.reply) messages.value.push({ role: 'assistant', content: data.reply })
    if (data.draft) {
      messages.value.push({
        role: 'draft',
        draft: data.draft,
        diff: Array.isArray(data.diff) ? data.diff : [],
        approval: data.approval,
      })
    }
    input.value = ''
    await scrollBottom()
  } catch (err) {
    // 503 未配置 / 429 额度用尽：把后端 reason 原样留在页面上，输入内容也不清空
    error.value = msgOf(err)
    await scrollBottom()
  } finally {
    sending.value = false
  }
}

function clearAll() {
  messages.value = []
  error.value = ''
  input.value = ''
}

onMounted(scrollBottom)
</script>

<template>
  <PageTemplate>
    <template #search>
      <span class="erp-weak erp-ellipsis" :title="t('f4.chat.hint')">{{ t('f4.chat.hint') }}</span>
    </template>

    <template #actions>
      <el-button :disabled="!messages.length && !error" data-test="clear" @click="clearAll">
        {{ t('f4.chat.clear') }}
      </el-button>
    </template>

    <el-alert
      v-if="!canChat()"
      class="err"
      type="warning"
      :title="t('f4.chat.needPerm')"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="error"
      class="err"
      type="error"
      :title="t('f4.chat.unavailable')"
      :closable="false"
      show-icon
    >
      <div class="err-body">{{ error }}</div>
      <el-button size="small" class="err-btn" :loading="sending" @click="send">{{ t('f4.chat.retry') }}</el-button>
    </el-alert>

    <div ref="stream" class="stream" data-test="stream">
      <el-empty v-if="!messages.length" :image-size="56" :description="t('f4.chat.empty')" />
      <template v-for="(m, i) in messages" :key="i">
        <div v-if="m.role === 'user'" class="msg msg-me">
          <div class="who erp-weak">{{ t('f4.chat.you') }}</div>
          <div class="bubble bubble-me">{{ m.content }}</div>
        </div>
        <div v-else-if="m.role === 'assistant'" class="msg msg-ai">
          <div class="who erp-weak">{{ t('f4.chat.assistant') }}</div>
          <div class="bubble bubble-ai">{{ m.content }}</div>
        </div>
        <div v-else class="msg msg-card" data-test="draft-card">
          <div class="card">
            <div class="card-head">
              <el-tag size="small" round effect="plain" type="primary">{{ t('f4.chat.draft') }}</el-tag>
              <span class="mono erp-ellipsis" :title="m.draft.toolName">{{ m.draft.toolName }}</span>
            </div>
            <div v-if="m.draft.preview?.summary" class="summary">{{ m.draft.preview.summary }}</div>
            <el-table v-if="isDiff(m.draft.preview)" :data="m.draft.preview.diff" border size="small">
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
            <pre v-else class="json erp-clamp-2" :title="pretty(m.draft.preview)">{{ pretty(m.draft.preview) }}</pre>
            <div class="card-foot erp-weak">
              <span>{{ t('f4.chat.draftHint') }}</span>
              <span v-if="m.approval?.id" class="mono">#{{ shortId(m.approval.id) }}</span>
            </div>
          </div>
        </div>
      </template>
      <div v-if="sending" class="msg msg-ai">
        <div class="who erp-weak">{{ t('f4.chat.assistant') }}</div>
        <div class="bubble bubble-ai erp-weak">{{ t('f4.chat.thinking') }}</div>
      </div>
    </div>

    <div class="composer">
      <el-input
        v-model="input"
        type="textarea"
        :rows="3"
        resize="none"
        maxlength="8000"
        :placeholder="t('f4.chat.placeholder')"
        :disabled="!canChat() || sending"
        data-test="chat-input"
        @keydown.ctrl.enter.prevent="send"
      />
      <div class="composer-foot">
        <span class="erp-weak">{{ t('f4.chat.hint') }}</span>
        <el-button
          type="primary"
          :loading="sending"
          :disabled="!canChat()"
          data-test="send"
          @click="send"
        >
          {{ t('f4.chat.send') }}
        </el-button>
      </div>
    </div>

    <template #hint>
      {{ tp('f4.chat.turns', { n: turns }) }}
    </template>
  </PageTemplate>
</template>

<style scoped>
.err {
  margin-bottom: 12px;
}
.err-body {
  font-size: 13px;
  word-break: break-word;
}
.err-btn {
  margin-top: 8px;
}
.stream {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 50vh;
  min-height: 140px;
  overflow-y: auto;
  padding: 4px 2px;
}
.msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.msg-me {
  align-items: flex-end;
}
.who {
  font-size: 11px;
}
.bubble {
  max-width: 78%;
  padding: 8px 12px;
  border-radius: var(--erp-radius-sm);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble-me {
  background: var(--erp-primary-soft);
  color: var(--erp-text);
}
.bubble-ai {
  background: var(--erp-surface-2);
  border: 1px solid var(--erp-border);
  color: var(--erp-text);
}
.msg-card {
  align-items: stretch;
}
.card {
  border: 1px solid var(--erp-border);
  border-radius: var(--erp-radius-sm);
  background: var(--erp-surface-2);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.summary {
  font-size: 13px;
  color: var(--erp-text);
}
.json {
  margin: 0;
  padding: 8px;
  background: var(--erp-surface);
  border-radius: var(--erp-radius-sm);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: var(--erp-text-2);
  white-space: pre-wrap;
  word-break: break-word;
}
.composer {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
@media (max-width: 900px) {
  .stream {
    max-height: 46vh;
  }
  .bubble {
    max-width: 92%;
  }
}
</style>
