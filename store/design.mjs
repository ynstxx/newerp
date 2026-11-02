import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 租户表：所有语句必带 $t
const COLS = 'id, project_id, title, version, content, status, confirmed_by, confirmed_at, created_at, updated_at'
const LINE_COLS = 'id, design_doc_id, line_no, item_name, spec, uom, qty, unit_cost, note'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM design_doc WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string }} f
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
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args

  args.push(f.limit + 1)
  const sql =
    `SELECT ${COLS} FROM design_doc WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * 下一个方案版本号 = 该项目已有方案数 + 1（租户内按 project_id 取 max）
 * @param {any} ctx @param {string} projectId
 */
export const nextVersion = (ctx, projectId) =>
  one(ctx, `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM design_doc WHERE $t AND project_id = $1`, [projectId])

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, title: string, version: number, content: string | null, status: string, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO design_doc (tenant_id, id, project_id, title, version, content, status, confirmed_by, confirmed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, $8)`,
    [ctx.tenantId, p.id, p.projectId, p.title, p.version, p.content, p.status, p.now],
  )

/**
 * version 是"第几版方案"这个业务号，不做自增；这里用它当乐观锁的值。
 * @param {any} ctx
 * @param {{ id: string, content: string | null, expectedVersion: number, status: string, now: Date }} p
 */
export const update = (ctx, p) =>
  exec(
    ctx,
    `UPDATE design_doc SET content = $1, updated_at = $2
      WHERE $t AND id = $3 AND version = $4 AND status = $5`,
    [p.content, p.now, p.id, p.expectedVersion, p.status],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, status: string, from: string, userId: string | null, now: Date }} p
 */
export const confirm = (ctx, p) =>
  exec(
    ctx,
    `UPDATE design_doc
        SET status = $1, confirmed_by = $2, confirmed_at = $3, updated_at = $3
      WHERE $t AND id = $4 AND status = $5`,
    [p.status, p.userId, p.now, p.id, p.from],
  )

// —— BOM 行：整批替换语义由 svc 用 deleteAll + insertOne 组合实现 ——

/** @param {any} ctx @param {string} designDocId */
export const linesByDoc = (ctx, designDocId) =>
  q(ctx, `SELECT ${LINE_COLS} FROM bom_line WHERE $t AND design_doc_id = $1 ORDER BY line_no ASC`, [designDocId])

/** @param {any} ctx @param {string} designDocId */
export const deleteLines = (ctx, designDocId) =>
  exec(ctx, `DELETE FROM bom_line WHERE $t AND design_doc_id = $1`, [designDocId])

/**
 * @param {any} ctx
 * @param {{ id: string, designDocId: string, lineNo: number, itemName: string, spec: string | null, uom: string | null, qty: number, unitCost: number, note: string | null }} p
 */
export const insertLine = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO bom_line (tenant_id, id, design_doc_id, line_no, item_name, spec, uom, qty, unit_cost, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [ctx.tenantId, p.id, p.designDocId, p.lineNo, p.itemName, p.spec, p.uom, p.qty, p.unitCost, p.note],
  )

// 跨切片只读：项目是否存在（不 import A 切片的 store）
/** @param {any} ctx @param {string} projectId */
export const projectExists = (ctx, projectId) => one(ctx, `SELECT id FROM project WHERE $t AND id = $1`, [projectId])
