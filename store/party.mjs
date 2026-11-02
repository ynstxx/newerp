import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 租户表：所有语句必带 $t
const COLS =
  'id, code, name, party_type, tax_no, contact_name, phone, email, addr, status, remark, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM party WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const byCode = (ctx, code) => one(ctx, `SELECT ${COLS} FROM party WHERE $t AND code = $1`, [code])

/**
 * 列表。过滤与排序都来自白名单常量，用户输入只进参数。
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, partyType?: string, keyword?: string }} f
 */
export function list(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []

  if (f.partyType) {
    args.push(f.partyType)
    conds.push(`party_type = $${args.length}`)
  }
  if (f.keyword) {
    args.push(`%${f.keyword}%`)
    conds.push(`(name LIKE $${args.length} OR code LIKE $${args.length})`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args

  args.push(f.limit + 1)
  const sql =
    `SELECT ${COLS} FROM party WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, code: string, name: string, partyType: string, taxNo: string | null, contactName: string | null, phone: string | null, email: string | null, addr: string | null, status: string, remark: string | null, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO party (tenant_id, id, code, name, party_type, tax_no, contact_name, phone, email, addr, status, remark, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 1, $13, $13)`,
    [
      ctx.tenantId,
      p.id,
      p.code,
      p.name,
      p.partyType,
      p.taxNo,
      p.contactName,
      p.phone,
      p.email,
      p.addr,
      p.status,
      p.remark,
      p.now,
    ],
  )

/**
 * 乐观锁：version 不匹配就是 0 行，交给上层区分 404 / 409
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, code: string, name: string, partyType: string, taxNo: string | null, contactName: string | null, phone: string | null, email: string | null, addr: string | null, status: string, remark: string | null, now: Date }} p
 */
export const update = (ctx, p) =>
  exec(
    ctx,
    `UPDATE party
        SET code = $1, name = $2, party_type = $3, tax_no = $4, contact_name = $5, phone = $6,
            email = $7, addr = $8, status = $9, remark = $10, version = version + 1, updated_at = $11
      WHERE $t AND id = $12 AND version = $13`,
    [
      p.code,
      p.name,
      p.partyType,
      p.taxNo,
      p.contactName,
      p.phone,
      p.email,
      p.addr,
      p.status,
      p.remark,
      p.now,
      p.id,
      p.expectedVersion,
    ],
  )

/** @param {any} ctx @param {string} id */
export const remove = (ctx, id) => exec(ctx, `DELETE FROM party WHERE $t AND id = $1`, [id])
