import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 租户表：所有语句必带 $t
const COLS =
  'id, code, name, party_id, opportunity_id, status, contract_amt, pm_user_id, start_date, end_date, note, version, created_at, updated_at'

const LOG_COLS = 'id, project_id, from_status, to_status, actor_id, note, at'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM project WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const byCode = (ctx, code) => one(ctx, `SELECT ${COLS} FROM project WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, status?: string, keyword?: string }} f
 */
export function list(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []

  if (f.status) {
    args.push(f.status)
    conds.push(`status = $${args.length}`)
  }
  if (f.keyword) {
    args.push(`%${f.keyword.toLowerCase()}%`)
    conds.push(`(LOWER(name) LIKE $${args.length} OR LOWER(code) LIKE $${args.length})`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args

  args.push(f.limit + 1)
  const sql =
    `SELECT ${COLS} FROM project WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, code: string, name: string, partyId: string, opportunityId: string | null, status: string, contractAmt: string, pmUserId: string | null, startDate: Date | null, endDate: Date | null, note: string | null, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO project (tenant_id, id, code, name, party_id, opportunity_id, status, contract_amt, pm_user_id, start_date, end_date, note, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $13)`,
    [
      ctx.tenantId,
      p.id,
      p.code,
      p.name,
      p.partyId,
      p.opportunityId,
      p.status,
      p.contractAmt,
      p.pmUserId,
      p.startDate,
      p.endDate,
      p.note,
      p.now,
    ],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, name: string, pmUserId: string | null, startDate: Date | null, endDate: Date | null, note: string | null, now: Date }} p
 */
export const update = (ctx, p) =>
  exec(
    ctx,
    `UPDATE project
        SET name = $1, pm_user_id = $2, start_date = $3, end_date = $4, note = $5,
            version = version + 1, updated_at = $6
      WHERE $t AND id = $7 AND version = $8`,
    [p.name, p.pmUserId, p.startDate, p.endDate, p.note, p.now, p.id, p.expectedVersion],
  )

/**
 * 状态推进：带上 from 兜底并发。合同切片会用等价的直接 UPDATE 把项目推到 signed。
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, now: Date }} p
 */
export const setStatus = (ctx, p) =>
  exec(
    ctx,
    `UPDATE project SET status = $1, version = version + 1, updated_at = $2 WHERE $t AND id = $3 AND status = $4`,
    [p.to, p.now, p.id, p.from],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, fromStatus: string | null, toStatus: string, actorId: string | null, note: string | null, at: Date }} p
 */
export const insertStageLog = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO project_stage_log (tenant_id, id, project_id, from_status, to_status, actor_id, note, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.tenantId, p.id, p.projectId, p.fromStatus, p.toStatus, p.actorId, p.note, p.at],
  )

/** @param {any} ctx @param {string} projectId */
export const stageLogs = (ctx, projectId) =>
  q(ctx, `SELECT ${LOG_COLS} FROM project_stage_log WHERE $t AND project_id = $1 ORDER BY at ASC, id ASC`, [
    projectId,
  ])
