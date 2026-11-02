import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 租户表：所有语句必带 $t。

// ── ai_settings ─────────────────────────────────────────────────────────────
const SETTINGS_COLS =
  'id, base_url, api_key, model, enabled, max_tokens, timeout_ms, monthly_token_limit, used_tokens, version, created_at, updated_at'

/** @param {any} ctx */
export const settingsGet = (ctx) => one(ctx, `SELECT ${SETTINGS_COLS} FROM ai_settings WHERE $t`, [])

/**
 * @param {any} ctx
 * @param {{ id: string, baseUrl: string | null, apiKey: string | null, model: string | null, enabled: boolean, maxTokens: number, timeoutMs: number, monthlyTokenLimit: number, now: Date }} p
 */
export const settingsInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO ai_settings (tenant_id, id, base_url, api_key, model, enabled, max_tokens, timeout_ms, monthly_token_limit, used_tokens, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 1, $10, $10)`,
    [
      ctx.tenantId,
      p.id,
      p.baseUrl,
      p.apiKey,
      p.model,
      p.enabled,
      p.maxTokens,
      p.timeoutMs,
      p.monthlyTokenLimit,
      p.now,
    ],
  )

/**
 * 乐观锁：version 不匹配就是 0 行，由 svc 转 409。
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, baseUrl: string | null, apiKey: string | null, model: string | null, enabled: boolean, maxTokens: number, timeoutMs: number, monthlyTokenLimit: number, now: Date }} p
 */
export const settingsUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE ai_settings
        SET base_url = $1, api_key = $2, model = $3, enabled = $4, max_tokens = $5,
            timeout_ms = $6, monthly_token_limit = $7, version = version + 1, updated_at = $8
      WHERE $t AND id = $9 AND version = $10`,
    [
      p.baseUrl,
      p.apiKey,
      p.model,
      p.enabled,
      p.maxTokens,
      p.timeoutMs,
      p.monthlyTokenLimit,
      p.now,
      p.id,
      p.expectedVersion,
    ],
  )

/**
 * 累计 token 用量。配额检查是软检查（并发两个请求可能略微超额），但不静默失败。
 * @param {any} ctx @param {string} id @param {number} tokens @param {Date} now
 */
export const settingsAddUsage = (ctx, id, tokens, now) =>
  exec(
    ctx,
    `UPDATE ai_settings SET used_tokens = used_tokens + $1, version = version + 1, updated_at = $2 WHERE $t AND id = $3`,
    [tokens, now, id],
  )

// ── ai_draft ────────────────────────────────────────────────────────────────
const DRAFT_COLS =
  'id, tool_name, payload, preview, status, submitter_id, applied_ref_type, applied_ref_id, error, version, created_at, updated_at'

/**
 * @param {any} ctx
 * @param {{ id: string, toolName: string, payload: unknown, preview: unknown, status: string, submitterId: string, now: Date }} d
 */
export const draftInsert = (ctx, d) =>
  exec(
    ctx,
    `INSERT INTO ai_draft (tenant_id, id, tool_name, payload, preview, status, submitter_id, applied_ref_type, applied_ref_id, error, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, 1, $8, $8)`,
    [ctx.tenantId, d.id, d.toolName, JSON.stringify(d.payload), JSON.stringify(d.preview), d.status, d.submitterId, d.now],
  )

/** @param {any} ctx @param {string} id */
export const draftById = (ctx, id) => one(ctx, `SELECT ${DRAFT_COLS} FROM ai_draft WHERE $t AND id = $1`, [id])

/**
 * apply 的行锁：同一 draft 的并发 apply 必须排队，第二个看到 applied 直接返回原单。
 * @param {any} ctx @param {string} id
 */
export const draftByIdForUpdate = (ctx, id) =>
  one(ctx, `SELECT ${DRAFT_COLS} FROM ai_draft WHERE $t AND id = $1 FOR UPDATE`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, status?: string, toolName?: string }} f
 */
export function draftList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.status) {
    args.push(f.status)
    conds.push(`status = $${args.length}`)
  }
  if (f.toolName) {
    args.push(f.toolName)
    conds.push(`tool_name = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${DRAFT_COLS} FROM ai_draft WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * 人审回调（approval decide 事务内）：只有 pending 才更新，绝不覆盖已落库的草稿。
 * @param {any} ctx @param {string} id @param {string} status @param {Date} now
 */
export const draftFinishReview = (ctx, id, status, now) =>
  exec(
    ctx,
    `UPDATE ai_draft SET status = $1, version = version + 1, updated_at = $2 WHERE $t AND id = $3 AND status = 'pending'`,
    [status, now, id],
  )

/**
 * 落库成功：status / applied_ref 一次写完；带 version 条件，防止并发覆盖。
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, refType: string, refId: string, now: Date }} p
 */
export const draftMarkApplied = (ctx, p) =>
  exec(
    ctx,
    `UPDATE ai_draft
        SET status = 'applied', applied_ref_type = $1, applied_ref_id = $2, error = NULL,
            version = version + 1, updated_at = $3
      WHERE $t AND id = $4 AND version = $5`,
    [p.refType, p.refId, p.now, p.id, p.expectedVersion],
  )

/**
 * 落库失败：approved / failed 都可再次进入（修 payload 或换环境后重试）。
 * @param {any} ctx @param {string} id @param {string} error @param {Date} now
 */
export const draftMarkFailed = (ctx, id, error, now) =>
  exec(
    ctx,
    `UPDATE ai_draft
        SET status = 'failed', error = $1, version = version + 1, updated_at = $2
      WHERE $t AND id = $3 AND status IN ('approved', 'failed')`,
    [error, now, id],
  )

// ── ai_trace ────────────────────────────────────────────────────────────────
const TRACE_COLS =
  'id, draft_id, model, prompt_tokens, completion_tokens, cost_micros, duration_ms, tool_calls, created_at'

/**
 * @param {any} ctx
 * @param {{ id: string, draftId: string | null, model: string | null, promptTokens: number, completionTokens: number, costMicros: number, durationMs: number, toolCalls: unknown, now: Date }} t
 */
export const traceInsert = (ctx, t) =>
  exec(
    ctx,
    `INSERT INTO ai_trace (tenant_id, id, draft_id, model, prompt_tokens, completion_tokens, cost_micros, duration_ms, tool_calls, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      ctx.tenantId,
      t.id,
      t.draftId,
      t.model,
      t.promptTokens,
      t.completionTokens,
      t.costMicros,
      t.durationMs,
      t.toolCalls === undefined || t.toolCalls === null ? null : JSON.stringify(t.toolCalls),
      t.now,
    ],
  )

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, draftId?: string, model?: string }} f
 */
export function traceList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.draftId) {
    args.push(f.draftId)
    conds.push(`draft_id = $${args.length}`)
  }
  if (f.model) {
    args.push(f.model)
    conds.push(`model = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${TRACE_COLS} FROM ai_trace WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}
