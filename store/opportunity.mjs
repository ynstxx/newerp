import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 租户表：所有语句必带 $t
const COLS =
  'id, code, name, party_id, owner_id, stage, est_amount, expected_sign_at, note, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM opportunity WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const byCode = (ctx, code) => one(ctx, `SELECT ${COLS} FROM opportunity WHERE $t AND code = $1`, [code])

/**
 * 唯一一处跨表读：挂客户前确认客户在本租户存在，别让 FK 报错变成 500。
 * @param {any} ctx @param {string} id
 */
export const partyExists = (ctx, id) => one(ctx, `SELECT id FROM party WHERE $t AND id = $1`, [id])

/**
 * 列表。过滤与排序都来自白名单常量，用户输入只进参数。
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, stage?: string, keyword?: string }} f
 */
export function list(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []

  if (f.stage) {
    args.push(f.stage)
    conds.push(`stage = $${args.length}`)
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
    `SELECT ${COLS} FROM opportunity WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, code: string, name: string, partyId: string, ownerId: string | null, stage: string, estAmount: string, expectedSignAt: Date | null, note: string | null, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO opportunity (tenant_id, id, code, name, party_id, owner_id, stage, est_amount, expected_sign_at, note, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11)`,
    [ctx.tenantId, p.id, p.code, p.name, p.partyId, p.ownerId, p.stage, p.estAmount, p.expectedSignAt, p.note, p.now],
  )

/**
 * 乐观锁：version 不匹配就是 0 行，交给上层区分 404 / 409
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, code: string, name: string, partyId: string, ownerId: string | null, estAmount: string, expectedSignAt: Date | null, note: string | null, now: Date }} p
 */
export const update = (ctx, p) =>
  exec(
    ctx,
    `UPDATE opportunity
        SET code = $1, name = $2, party_id = $3, owner_id = $4, est_amount = $5,
            expected_sign_at = $6, note = $7, version = version + 1, updated_at = $8
      WHERE $t AND id = $9 AND version = $10`,
    [p.code, p.name, p.partyId, p.ownerId, p.estAmount, p.expectedSignAt, p.note, p.now, p.id, p.expectedVersion],
  )

/**
 * 状态推进：带上 from 做兜底，两个并发 advance 只有一个能成。
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, now: Date }} p
 */
export const setStage = (ctx, p) =>
  exec(
    ctx,
    `UPDATE opportunity SET stage = $1, version = version + 1, updated_at = $2 WHERE $t AND id = $3 AND stage = $4`,
    [p.to, p.now, p.id, p.from],
  )
