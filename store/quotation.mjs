import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 租户表：所有语句必带 $t
const COLS =
  'id, project_id, code, version, party_id, amount, valid_until, status, sent_at, decided_at, note, created_at, updated_at'
const LINE_COLS = 'id, quotation_id, line_no, item_name, spec, uom, qty, price, amount, note'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM quotation WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const byCode = (ctx, code) => one(ctx, `SELECT ${COLS} FROM quotation WHERE $t AND code = $1`, [code])

/** @param {any} ctx @param {string} projectId */
export const countByProject = (ctx, projectId) =>
  one(ctx, `SELECT COUNT(*) AS n FROM quotation WHERE $t AND project_id = $1`, [projectId])

/** @param {any} ctx @param {string} quotationId */
export const linesByQuotation = (ctx, quotationId) =>
  q(ctx, `SELECT ${LINE_COLS} FROM quotation_line WHERE $t AND quotation_id = $1 ORDER BY line_no ASC`, [quotationId])

/**
 * 列表。过滤与排序都来自白名单常量，用户输入只进参数。
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, status?: string }} f
 */
export function list(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []

  if (f.projectId) {
    args.push(f.projectId)
    conds.push(`project_id = $${args.length}`)
  }
  if (f.status) {
    args.push(f.status)
    conds.push(`status = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args

  args.push(f.limit + 1)
  const sql =
    `SELECT ${COLS} FROM quotation WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, code: string, version: number, partyId: string, amount: string, validUntil: Date | null, status: string, sentAt: Date | null, decidedAt: Date | null, note: string | null, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO quotation (tenant_id, id, project_id, code, version, party_id, amount, valid_until, status, sent_at, decided_at, note, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
    [
      ctx.tenantId,
      p.id,
      p.projectId,
      p.code,
      p.version,
      p.partyId,
      p.amount,
      p.validUntil,
      p.status,
      p.sentAt,
      p.decidedAt,
      p.note,
      p.now,
    ],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, quotationId: string, lineNo: number, itemName: string, spec: string | null, uom: string | null, qty: string, price: string, amount: string, note: string | null }} p
 */
export const insertLine = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO quotation_line (tenant_id, id, quotation_id, line_no, item_name, spec, uom, qty, price, amount, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [ctx.tenantId, p.id, p.quotationId, p.lineNo, p.itemName, p.spec, p.uom, p.qty, p.price, p.amount, p.note],
  )

/**
 * 状态推进：带上 from 状态兜底并发（version 是"第几版"，不当乐观锁用）
 * @param {any} ctx
 * @param {{ id: string, from: string, status: string, sentAt: Date | null, decidedAt: Date | null, now: Date }} p
 */
export const updateStatus = (ctx, p) =>
  exec(
    ctx,
    `UPDATE quotation
        SET status = $1, sent_at = $2, decided_at = $3, updated_at = $4
      WHERE $t AND id = $5 AND status = $6`,
    [p.status, p.sentAt, p.decidedAt, p.now, p.id, p.from],
  )

// ---- 跨切片只读（报价从 BOM 快照，不 import 别人的 store）----

/** @param {any} ctx @param {string} id */
export const designDocById = (ctx, id) =>
  one(ctx, `SELECT id, project_id, title, version, status FROM design_doc WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} designDocId */
export const bomLinesByDesignDoc = (ctx, designDocId) =>
  q(
    ctx,
    `SELECT line_no, item_name, spec, uom, qty, unit_cost, note FROM bom_line
      WHERE $t AND design_doc_id = $1 ORDER BY line_no ASC`,
    [designDocId],
  )

/** @param {any} ctx @param {string} id */
export const projectById = (ctx, id) =>
  one(ctx, `SELECT id, code, name, party_id, status FROM project WHERE $t AND id = $1`, [id])
