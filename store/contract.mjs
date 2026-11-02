import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 租户表：所有语句必带 $t
const COLS =
  'id, project_id, quotation_id, code, name, party_id, amount, sign_at, status, note, created_at, updated_at'
const LINE_COLS = 'id, contract_id, line_no, item_name, spec, uom, qty, price, amount'
const TERM_COLS = 'id, contract_id, seq, title, content'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM contract WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const byCode = (ctx, code) => one(ctx, `SELECT ${COLS} FROM contract WHERE $t AND code = $1`, [code])

/**
 * 列表。过滤与排序都来自白名单常量，用户输入只进参数。
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, status?: string, keyword?: string }} f
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
  if (f.keyword) {
    args.push(`%${f.keyword.toLowerCase()}%`)
    conds.push(`(LOWER(code) LIKE $${args.length} OR LOWER(name) LIKE $${args.length})`)
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
    `SELECT ${COLS} FROM contract WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/** @param {any} ctx @param {string} contractId */
export const linesOf = (ctx, contractId) =>
  q(ctx, `SELECT ${LINE_COLS} FROM contract_line WHERE $t AND contract_id = $1 ORDER BY line_no`, [contractId])

/** @param {any} ctx @param {string} contractId */
export const termsOf = (ctx, contractId) =>
  q(ctx, `SELECT ${TERM_COLS} FROM contract_term WHERE $t AND contract_id = $1 ORDER BY seq`, [contractId])

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, quotationId: string, code: string, name: string, partyId: string, amount: string, signAt: Date | null, status: string, note: string | null, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO contract (tenant_id, id, project_id, quotation_id, code, name, party_id, amount, sign_at, status, note, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      ctx.tenantId,
      p.id,
      p.projectId,
      p.quotationId,
      p.code,
      p.name,
      p.partyId,
      p.amount,
      p.signAt,
      p.status,
      p.note,
      p.now,
    ],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, contractId: string, lineNo: number, itemName: string, spec: string | null, uom: string | null, qty: unknown, price: unknown, amount: unknown }} p
 */
export const insertLine = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO contract_line (tenant_id, id, contract_id, line_no, item_name, spec, uom, qty, price, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [ctx.tenantId, p.id, p.contractId, p.lineNo, p.itemName, p.spec, p.uom, p.qty, p.price, p.amount],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, contractId: string, seq: number, title: string, content: string }} p
 */
export const insertTerm = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO contract_term (tenant_id, id, contract_id, seq, title, content) VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.tenantId, p.id, p.contractId, p.seq, p.title, p.content],
  )

/**
 * 签约：状态与签署时间一起落库，不单独放一个裸 UPDATE status。
 * `AND status = $5` 是并发兜底 —— 两个并发 advance 只有一个能改到行。
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, signAt: Date, now: Date }} p
 */
export const markSigned = (ctx, p) =>
  exec(
    ctx,
    `UPDATE contract SET status = $1, sign_at = $2, updated_at = $3 WHERE $t AND id = $4 AND status = $5`,
    [p.to, p.signAt, p.now, p.id, p.from],
  )

/**
 * ---- 跨切片只读/联动（合同读报价、签约推项目）----
 * 并行期不 import 别人的 store，合并后可选收敛。
 */

/** @param {any} ctx @param {string} id */
export const quotationById = (ctx, id) =>
  one(
    ctx,
    `SELECT id, project_id, code, version, party_id, amount, status FROM quotation WHERE $t AND id = $1`,
    [id],
  )

/** @param {any} ctx @param {string} quotationId */
export const quotationLinesOf = (ctx, quotationId) =>
  q(
    ctx,
    `SELECT line_no, item_name, spec, uom, qty, price, amount FROM quotation_line
      WHERE $t AND quotation_id = $1 ORDER BY line_no`,
    [quotationId],
  )

/** @param {any} ctx @param {string} id */
export const projectById = (ctx, id) =>
  one(ctx, `SELECT id, code, status, party_id, version FROM project WHERE $t AND id = $1`, [id])

/**
 * 签约联动：project 推到 signed，并把合同额落到项目上。
 * `AND status = $4` 让 project 的状态迁移在 DB 层也有兜底（DESIGN §7.3 唯一写入口纪律），
 * 影响 0 行 → 上层按并发冲突处理，而不是当成"单据不存在"。
 * @param {any} ctx @param {{ projectId: string, from: string, amount: string, now: Date }} p
 */
export const markProjectSigned = (ctx, p) =>
  exec(
    ctx,
    `UPDATE project
        SET status = $1, contract_amt = $2, version = version + 1, updated_at = $3
      WHERE $t AND id = $4 AND status = $5`,
    ['signed', p.amount, p.now, p.projectId, p.from],
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
