import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

const COLS = 'id, contract_id, name, cron_note, next_at, enabled, created_at, updated_at'
const TASK_COLS = 'id, plan_id, due_at, done_at, result, assignee_id'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM maintenance_plan WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, contractId?: string, enabled?: boolean, keyword?: string }} f
 */
export function list(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []

  if (f.contractId) {
    args.push(f.contractId)
    conds.push(`contract_id = $${args.length}`)
  }
  if (f.enabled !== undefined) {
    args.push(f.enabled)
    conds.push(`enabled = $${args.length}`)
  }
  if (f.keyword) {
    args.push(`%${f.keyword.toLowerCase()}%`)
    conds.push(`LOWER(name) LIKE $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args

  args.push(f.limit + 1)
  const sql =
    `SELECT ${COLS} FROM maintenance_plan WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, contractId: string, name: string, cronNote: string | null, nextAt: Date | null, enabled: boolean, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO maintenance_plan (tenant_id, id, contract_id, name, cron_note, next_at, enabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [ctx.tenantId, p.id, p.contractId, p.name, p.cronNote, p.nextAt, p.enabled, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, contractId: string, name: string, cronNote: string | null, nextAt: Date | null, enabled: boolean, now: Date }} p
 */
export const update = (ctx, p) =>
  exec(
    ctx,
    `UPDATE maintenance_plan
        SET contract_id = $1, name = $2, cron_note = $3, next_at = $4, enabled = $5, updated_at = $6
      WHERE $t AND id = $7`,
    [p.contractId, p.name, p.cronNote, p.nextAt, p.enabled, p.now, p.id],
  )

/** @param {any} ctx @param {string} planId */
export const tasksOf = (ctx, planId) =>
  q(ctx, `SELECT ${TASK_COLS} FROM maintenance_task WHERE $t AND plan_id = $1 ORDER BY due_at ASC, id ASC`, [planId])

/** @param {any} ctx @param {string} id */
export const taskById = (ctx, id) => one(ctx, `SELECT ${TASK_COLS} FROM maintenance_task WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx
 * @param {{ id: string, planId: string, dueAt: Date, assigneeId: string | null }} p
 */
export const insertTask = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO maintenance_task (tenant_id, id, plan_id, due_at, done_at, result, assignee_id)
     VALUES ($1, $2, $3, $4, NULL, NULL, $5)`,
    [ctx.tenantId, p.id, p.planId, p.dueAt, p.assigneeId],
  )

/**
 * 完成巡检任务：`done_at IS NULL` 兜住重复提交（第二次 0 行 → 409）。
 * @param {any} ctx @param {{ id: string, result: string | null, now: Date }} p
 */
export const finishTask = (ctx, p) =>
  exec(
    ctx,
    `UPDATE maintenance_task SET done_at = $1, result = $2 WHERE $t AND id = $3 AND done_at IS NULL`,
    [p.now, p.result, p.id],
  )
