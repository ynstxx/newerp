import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/ai.mjs'
import { decrypt, encrypt } from './ai_crypto.mjs'

/**
 * 租户级 AI 配置（DESIGN §12.3）。
 * 离线部署：enabled=false / 无 api_key 时 AI 入口一律 503 并给出原因，其余功能不受影响；
 * 超配额 429，不静默失败。
 */

/** @type {import('../http/errors.mjs').ErrDef} */
const UNAVAILABLE = { code: 'ai_unavailable', status: 503, zh: 'AI 未启用', en: 'AI unavailable' }
/** @type {import('../http/errors.mjs').ErrDef} */
const QUOTA_EXCEEDED = { code: 'ai_quota_exceeded', status: 429, zh: 'AI 配额已用尽', en: 'AI quota exceeded' }

const MAX_URL = 500

/** @param {any} row */
function notReadyReason(row) {
  if (!row || !row.base_url || !row.model) return '尚未配置 AI 端点（base_url / model）'
  if (!row.enabled) return 'AI 已在租户设置中关闭（enabled=false）'
  if (!row.api_key) return '未配置 api_key'
  if (Number(row.monthly_token_limit) > 0 && Number(row.used_tokens) >= Number(row.monthly_token_limit)) {
    return `本月 token 配额已用尽（${row.used_tokens}/${row.monthly_token_limit}）`
  }
  return null
}

/** 对外视图：api_key 只回"已配置"，明文与密文都不出网。 */
export const toApi = (/** @type {any} */ row) => {
  const reason = notReadyReason(row)
  return {
    id: row?.id ?? null,
    baseUrl: row?.base_url ?? null,
    model: row?.model ?? null,
    apiKey: { configured: Boolean(row?.api_key) },
    enabled: Boolean(row?.enabled),
    maxTokens: row?.max_tokens ?? 1024,
    timeoutMs: row?.timeout_ms ?? 15000,
    monthlyTokenLimit: row?.monthly_token_limit ?? 0,
    usedTokens: row?.used_tokens ?? 0,
    ready: reason === null,
    reason,
    version: row?.version ?? 0,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
  }
}

/** @param {any} ctx */
export async function getSettings(ctx) {
  return toApi(await store.settingsGet(ctx))
}

/**
 * @param {unknown} raw
 */
function normBaseUrl(raw) {
  const s = String(raw ?? '').trim().replace(/\/+$/, '')
  if (!s) return null
  if (s.length > MAX_URL) throw new HttpError(errors.badRequest, { fields: { baseUrl: `max:${MAX_URL}` } })
  let url
  try {
    url = new URL(s)
  } catch {
    throw new HttpError(errors.badRequest, { fields: { baseUrl: 'url' } })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(errors.badRequest, { fields: { baseUrl: 'http(s)' } })
  }
  return s
}

/**
 * PUT 语义但允许局部更新：不传的字段保持原值。
 * apiKey：不传 = 保持；传空串 = 清除；传明文 = 加密后落库。
 * @param {any} ctx
 * @param {{ baseUrl?: string | null, apiKey?: string, model?: string | null, enabled?: boolean, maxTokens?: number, timeoutMs?: number, monthlyTokenLimit?: number, version?: number }} patch
 */
export async function updateSettings(ctx, patch) {
  const cur = await store.settingsGet(ctx)
  const now = new Date()

  const baseUrl = patch.baseUrl !== undefined ? normBaseUrl(patch.baseUrl) : (cur?.base_url ?? null)
  const model = patch.model !== undefined ? (patch.model ? String(patch.model) : null) : (cur?.model ?? null)
  const enabled = patch.enabled !== undefined ? patch.enabled : Boolean(cur?.enabled)
  const maxTokens = patch.maxTokens !== undefined ? patch.maxTokens : (cur?.max_tokens ?? 1024)
  const timeoutMs = patch.timeoutMs !== undefined ? patch.timeoutMs : (cur?.timeout_ms ?? 15000)
  const monthlyTokenLimit =
    patch.monthlyTokenLimit !== undefined ? patch.monthlyTokenLimit : (cur?.monthly_token_limit ?? 0)

  let apiKey = cur?.api_key ?? null
  if (patch.apiKey !== undefined) {
    const plain = String(patch.apiKey).trim()
    apiKey = plain ? encrypt(plain) : null
  }

  if (!cur) {
    const id = randomUUID()
    await withTx(ctx, async (tx) => {
      await store.settingsInsert(tx, {
        id,
        baseUrl,
        apiKey,
        model,
        enabled,
        maxTokens,
        timeoutMs,
        monthlyTokenLimit,
        now,
      })
      await audit.insert(tx, {
        id: randomUUID(),
        module: 'ai',
        action: 'create_settings',
        whoId: ctx.userId ?? null,
        refType: 'ai_settings',
        refId: id,
        before: null,
        after: { baseUrl, model, enabled, maxTokens, timeoutMs, monthlyTokenLimit, apiKeyConfigured: Boolean(apiKey) },
        traceId: ctx.requestId ?? '',
        at: now,
      })
    })
    return getSettings(ctx)
  }

  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }

  await withTx(ctx, async (tx) => {
    const n = await store.settingsUpdate(tx, {
      id: cur.id,
      expectedVersion: cur.version,
      baseUrl,
      apiKey,
      model,
      enabled,
      maxTokens,
      timeoutMs,
      monthlyTokenLimit,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'ai',
      action: 'update_settings',
      whoId: ctx.userId ?? null,
      refType: 'ai_settings',
      refId: cur.id,
      // 密钥只记"是否配置"，绝不把密文写进审计
      before: { baseUrl: cur.base_url, model: cur.model, enabled: Boolean(cur.enabled), apiKeyConfigured: Boolean(cur.api_key) },
      after: { baseUrl, model, enabled, apiKeyConfigured: Boolean(apiKey) },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getSettings(ctx)
}

/**
 * 所有 AI 功能入口的守卫：未配置/关闭 → 503；超配额 → 429。
 * 返回解密后的明文 key，只在调用 LLM 的瞬间存在内存里。
 * @param {any} ctx
 */
export async function assertReady(ctx) {
  const row = await store.settingsGet(ctx)
  const reason = notReadyReason(row)
  if (!reason) {
    try {
      return { row, apiKey: decrypt(String(row.api_key)) }
    } catch (err) {
      // 密文损坏 / APP_SECRET 换了：明确报错，不当作"没配置"静默降级
      throw new HttpError(UNAVAILABLE, { reason: `api_key 无法解密：${/** @type {Error} */ (err).message}` })
    }
  }
  const quota = row && Number(row.monthly_token_limit) > 0 && Number(row.used_tokens) >= Number(row.monthly_token_limit)
  throw new HttpError(quota ? QUOTA_EXCEEDED : UNAVAILABLE, { reason })
}

