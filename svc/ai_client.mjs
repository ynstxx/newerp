import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import * as store from '../store/ai.mjs'

/**
 * OpenAI 兼容客户端（DESIGN §12.3）：零依赖，`fetch` 直连 `<base_url>/chat/completions`。
 * base_url 可注入 —— 测试用本地 node:http 假服务器，绝不连真 API。
 *
 * 每次都写 ai_trace（prompt/completion/耗时/tool_calls），并按租户累加 used_tokens。
 */

/** @type {import('../http/errors.mjs').ErrDef} */
const UPSTREAM = { code: 'ai_upstream', status: 502, zh: 'AI 上游失败', en: 'AI upstream failed' }

/**
 * @typedef {object} CompleteResult
 * @property {any} message  choices[0].message
 * @property {any[]} toolCalls
 * @property {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }} usage
 * @property {number} durationMs
 * @property {string} model
 */

/**
 * 单次 chat/completions 调用。
 * 不自动重试：LLM 调用按 token 计费，重试会把一次失败变成两份账单。
 * @param {any} ctx
 * @param {{ settings: any, apiKey: string, messages: unknown[], tools?: unknown[], timeoutMs?: number }} opts
 * @returns {Promise<CompleteResult>}
 */
export async function complete(ctx, opts) {
  const base = String(opts.settings.base_url ?? '').replace(/\/+$/, '')
  if (!base) throw new HttpError(UPSTREAM, { reason: 'base_url 为空' })
  const url = `${base}/chat/completions`
  const timeoutMs = Number(opts.timeoutMs ?? opts.settings.timeout_ms ?? 15000) || 15000
  const model = String(opts.settings.model ?? '')

  /** @type {Record<string, unknown>} */
  const body = {
    model,
    messages: opts.messages,
    max_tokens: Number(opts.settings.max_tokens ?? 1024) || 1024,
    temperature: 0,
    stream: false,
  }
  if (opts.tools?.length) {
    body.tools = opts.tools
    body.tool_choice = 'auto'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  /** @type {Response} */
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    const msg = /** @type {Error} */ (err).name === 'AbortError' ? `超时 ${timeoutMs}ms` : /** @type {Error} */ (err).message
    throw new HttpError(UPSTREAM, { reason: `AI 端点不可达（${url}）：${msg}` })
  } finally {
    clearTimeout(timer)
  }

  const text = await res.text()
  const durationMs = Date.now() - started

  /** @type {any} */
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new HttpError(UPSTREAM, { reason: `AI 端点返回的不是 JSON（HTTP ${res.status}）` })
  }
  if (!res.ok) {
    const detail = data?.error?.message ?? data?.message ?? text.slice(0, 200)
    throw new HttpError(UPSTREAM, { reason: `AI 端点返回 HTTP ${res.status}：${detail}` })
  }
  const message = data?.choices?.[0]?.message
  if (!message || typeof message !== 'object') {
    throw new HttpError(UPSTREAM, { reason: 'AI 响应缺少 choices[0].message' })
  }

  const usage = {
    prompt_tokens: Number(data?.usage?.prompt_tokens ?? 0) || 0,
    completion_tokens: Number(data?.usage?.completion_tokens ?? 0) || 0,
    total_tokens: Number(data?.usage?.total_tokens ?? 0) || 0,
  }
  if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens

  return {
    message,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage,
    durationMs,
    model,
  }
}

/**
 * 写 ai_trace 并累加租户 used_tokens（同一事务，配额与轨迹一起落地）。
 * @param {any} ctx
 * @param {{ draftId?: string | null, model?: string | null, usage?: { prompt_tokens?: number, completion_tokens?: number }, durationMs?: number, toolCalls?: unknown }} t
 */
export async function recordTrace(ctx, t = {}) {
  const prompt = Number(t.usage?.prompt_tokens ?? 0) || 0
  const completion = Number(t.usage?.completion_tokens ?? 0) || 0
  const total = prompt + completion
  const now = new Date()

  await withTx(ctx, async (tx) => {
    await store.traceInsert(tx, {
      id: randomUUID(),
      draftId: t.draftId ?? null,
      model: t.model ?? null,
      promptTokens: prompt,
      completionTokens: completion,
      costMicros: 0,
      durationMs: Number(t.durationMs ?? 0) || 0,
      toolCalls: t.toolCalls ?? null,
      now,
    })
    const settings = await store.settingsGet(tx)
    if (settings && total > 0) await store.settingsAddUsage(tx, settings.id, total, now)
  })
}

/** @param {unknown} raw */
export function parseToolArgs(raw) {
  if (raw === undefined || raw === null || raw === '') return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch {
    throw new HttpError(errors.badRequest, { reason: '模型返回的 tool_call.arguments 不是合法 JSON' })
  }
}

/** @param {any} r */
const traceToApi = (r) => ({
  id: r.id,
  draftId: r.draft_id,
  model: r.model,
  promptTokens: r.prompt_tokens,
  completionTokens: r.completion_tokens,
  costMicros: r.cost_micros,
  durationMs: r.duration_ms,
  toolCalls: typeof r.tool_calls === 'string' ? JSON.parse(r.tool_calls) : r.tool_calls,
  createdAt: r.created_at,
})

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, draftId?: string, model?: string }} page
 */
export async function listTraces(ctx, page) {
  const rows = await store.traceList(ctx, page)
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(traceToApi), nextCursor }
}
