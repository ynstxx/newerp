import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

const COLS =
  'id, code, party_id, name, start_at, end_at, sla_level, response_minutes, resolve_minutes, amount, status, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM service_contract WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const byCode = (ctx, code) => one(ctx, `SELECT ${COLS} FROM service_contract WHERE $t AND code = $1`, [code])

/** @param {any} ctx @param {string} id */
export const partyById = (ctx, id) =>
  one(ctx, `SELECT id, code, name, status FROM party WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, status?: string, partyId?: string, keyword?: string }} f
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
  if (f.partyId) {
    args.push(f.partyId)
    conds.push(`party_id = $${args.length}`)
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
    `SELECT ${COLS} FROM service_contract WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, code: string, partyId: string, name: string, startAt: Date | null, endAt: Date | null, slaLevel: string, responseMinutes: number, resolveMinutes: number, amount: string, status: string, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO service_contract
       (tenant_id, id, code, party_id, name, start_at, end_at, sla_level, response_minutes, resolve_minutes, amount, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $13)`,
    [
      ctx.tenantId,
      p.id,
      p.code,
      p.partyId,
      p.name,
      p.startAt,
      p.endAt,
      p.slaLevel,
      p.responseMinutes,
      p.resolveMinutes,
      p.amount,
      p.status,
      p.now,
    ],
  )

/**
 * 乐观锁：version 不匹配返回 0 行，由 svc 转 409。
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, code: string, partyId: string, name: string, startAt: Date | null, endAt: Date | null, slaLevel: string, responseMinutes: number, resolveMinutes: number, amount: string, status: string, now: Date }} p
 */
export const update = (ctx, p) =>
  exec(
    ctx,
    `UPDATE service_contract
        SET code = $1, party_id = $2, name = $3, start_at = $4, end_at = $5,
            sla_level = $6, response_minutes = $7, resolve_minutes = $8, amount = $9,
            status = $10, version = version + 1, updated_at = $11
      WHERE $t AND id = $12 AND version = $13`,
    [
      p.code,
      p.partyId,
      p.name,
      p.startAt,
      p.endAt,
      p.slaLevel,
      p.responseMinutes,
      p.resolveMinutes,
      p.amount,
      p.status,
      p.now,
      p.id,
      p.expectedVersion,
    ],
  )

/** @param {any} ctx @param {string} id */
export const remove = (ctx, id) => exec(ctx, `DELETE FROM service_contract WHERE $t AND id = $1`, [id])

/** 删除前的引用检查：被工单/巡检计划引用过就不允许物理删除。 */
/** @param {any} ctx @param {string} id */
export function refs(ctx, id) {
  return Promise.all([
    one(ctx, `SELECT COUNT(*) AS n FROM ticket WHERE $t AND contract_id = $1`, [id]),
    one(ctx, `SELECT COUNT(*) AS n FROM maintenance_plan WHERE $t AND contract_id = $1`, [id]),
  ]).then(([t, p]) => Number(t?.n ?? 0) + Number(p?.n ?? 0))
}
