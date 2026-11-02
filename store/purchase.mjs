import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

/**
 * 采购与财务的读写。业务判断全部在 svc/purchase.mjs，这里只拼 SQL。
 * 租户谓词 `$t` 由 db 层展开成 `tenant_id = $n`（rebind），每条语句必带。
 */

// ── purchase_order ──────────────────────────────────────────────────────────
const PO_COLS =
  'id, project_id, party_id, code, amount, status, note, approved_at, version, created_by, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const poById = (ctx, id) => one(ctx, `SELECT ${PO_COLS} FROM purchase_order WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const poByCode = (ctx, code) =>
  one(ctx, `SELECT ${PO_COLS} FROM purchase_order WHERE $t AND code = $1`, [code])

/**
 * 锁住采购单行：并发收货/提交审批时把同一张单串行化。
 * @param {any} ctx @param {string} id
 */
export const lockPo = (ctx, id) =>
  one(ctx, `SELECT ${PO_COLS} FROM purchase_order WHERE $t AND id = $1 FOR UPDATE`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, partyId?: string, status?: string, keyword?: string }} f
 */
export function poList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.projectId) {
    args.push(f.projectId)
    conds.push(`project_id = $${args.length}`)
  }
  if (f.partyId) {
    args.push(f.partyId)
    conds.push(`party_id = $${args.length}`)
  }
  if (f.status) {
    args.push(f.status)
    conds.push(`status = $${args.length}`)
  }
  if (f.keyword) {
    args.push(`%${f.keyword.toLowerCase()}%`)
    conds.push(`LOWER(code) LIKE $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${PO_COLS} FROM purchase_order WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string | null, partyId: string, code: string, amount: string, status: string, note: string | null, createdBy: string | null, now: Date }} p
 */
export const poInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO purchase_order (tenant_id, id, project_id, party_id, code, amount, status, note, approved_at, version, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 1, $9, $10, $10)`,
    [ctx.tenantId, p.id, p.projectId, p.partyId, p.code, p.amount, p.status, p.note, p.createdBy, p.now],
  )

/**
 * 只允许改备注：金额由行合计得出，状态只能由审批/收货推进。
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, note: string | null, now: Date }} p
 */
export const poUpdateNote = (ctx, p) =>
  exec(
    ctx,
    `UPDATE purchase_order SET note = $1, version = version + 1, updated_at = $2
      WHERE $t AND id = $3 AND version = $4`,
    [p.note, p.now, p.id, p.expectedVersion],
  )

/**
 * 状态推进（带 `AND status = $from`，重复推进自然 0 行）。
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, now: Date, approvedAt?: Date | null }} p
 */
export const poSetStatus = (ctx, p) =>
  exec(
    ctx,
    `UPDATE purchase_order
        SET status = $1, approved_at = $2, version = version + 1, updated_at = $3
      WHERE $t AND id = $4 AND status = $5`,
    [p.to, p.approvedAt ?? null, p.now, p.id, p.from],
  )

// ── po_line ─────────────────────────────────────────────────────────────────
const POL_COLS = 'id, po_id, line_no, item_id, qty, price, amount'

/** @param {any} ctx @param {string} poId */
export const poLinesOf = (ctx, poId) =>
  q(ctx, `SELECT ${POL_COLS} FROM po_line WHERE $t AND po_id = $1 ORDER BY line_no ASC`, [poId])

/** @param {any} ctx @param {string} id */
export const poLineById = (ctx, id) => one(ctx, `SELECT ${POL_COLS} FROM po_line WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} id */
export const lockPoLine = (ctx, id) =>
  one(ctx, `SELECT ${POL_COLS} FROM po_line WHERE $t AND id = $1 FOR UPDATE`, [id])

/**
 * @param {any} ctx
 * @param {{ id: string, poId: string, lineNo: number, itemId: string, qty: string, price: string, amount: string }} p
 */
export const poLineInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO po_line (tenant_id, id, po_id, line_no, item_id, qty, price, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.tenantId, p.id, p.poId, p.lineNo, p.itemId, p.qty, p.price, p.amount],
  )

/** 已收数量（grn_line 之和）。收货前先锁 PO 行，再算这个。 @param {any} ctx @param {string} poLineId */
export const receivedQtyOf = async (ctx, poLineId) => {
  const row = await one(
    ctx,
    `SELECT COALESCE(SUM(qty), 0) AS received FROM grn_line WHERE $t AND po_line_id = $1`,
    [poLineId],
  )
  return String(row?.received ?? 0)
}

/** @param {any} ctx @param {string} poId */
export const receivedQtyByPo = (ctx, poId) =>
  q(
    ctx,
    `SELECT po_line_id, SUM(qty) AS received FROM grn_line
      WHERE $t AND po_line_id IN (SELECT id FROM po_line WHERE $t AND po_id = $1)
      GROUP BY po_line_id`,
    [poId],
  )

// ── goods_receipt / grn_line ────────────────────────────────────────────────
const GRN_COLS =
  'id, po_id, warehouse_id, code, status, received_at, note, version, received_by, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const receiptById = (ctx, id) => one(ctx, `SELECT ${GRN_COLS} FROM goods_receipt WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const receiptByCode = (ctx, code) =>
  one(ctx, `SELECT ${GRN_COLS} FROM goods_receipt WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, poId?: string, warehouseId?: string }} f
 */
export function receiptList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.poId) {
    args.push(f.poId)
    conds.push(`po_id = $${args.length}`)
  }
  if (f.warehouseId) {
    args.push(f.warehouseId)
    conds.push(`warehouse_id = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${GRN_COLS} FROM goods_receipt WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, poId: string, warehouseId: string, code: string, status: string, receivedAt: Date, note: string | null, receivedBy: string | null, now: Date }} p
 */
export const receiptInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO goods_receipt (tenant_id, id, po_id, warehouse_id, code, status, received_at, note, version, received_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, $10)`,
    [ctx.tenantId, p.id, p.poId, p.warehouseId, p.code, p.status, p.receivedAt, p.note, p.receivedBy, p.now],
  )

const GRNL_COLS = 'id, receipt_id, po_line_id, item_id, qty, price, amount'

/**
 * @param {any} ctx
 * @param {{ id: string, receiptId: string, poLineId: string, itemId: string, qty: string, price: string, amount: string }} p
 */
export const grnLineInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO grn_line (tenant_id, id, receipt_id, po_line_id, item_id, qty, price, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.tenantId, p.id, p.receiptId, p.poLineId, p.itemId, p.qty, p.price, p.amount],
  )

/** @param {any} ctx @param {string} receiptId */
export const grnLinesOf = (ctx, receiptId) =>
  q(ctx, `SELECT ${GRNL_COLS} FROM grn_line WHERE $t AND receipt_id = $1 ORDER BY id ASC`, [receiptId])

// ── subcontract ─────────────────────────────────────────────────────────────
const SUB_COLS =
  'id, project_id, party_id, code, name, amount, status, note, approved_at, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const subById = (ctx, id) => one(ctx, `SELECT ${SUB_COLS} FROM subcontract WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const subByCode = (ctx, code) => one(ctx, `SELECT ${SUB_COLS} FROM subcontract WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, partyId?: string, status?: string }} f
 */
export function subList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.projectId) {
    args.push(f.projectId)
    conds.push(`project_id = $${args.length}`)
  }
  if (f.partyId) {
    args.push(f.partyId)
    conds.push(`party_id = $${args.length}`)
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
    `SELECT ${SUB_COLS} FROM subcontract WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, partyId: string, code: string, name: string, amount: string, status: string, note: string | null, now: Date }} p
 */
export const subInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO subcontract (tenant_id, id, project_id, party_id, code, name, amount, status, note, approved_at, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, 1, $10, $10)`,
    [ctx.tenantId, p.id, p.projectId, p.partyId, p.code, p.name, p.amount, p.status, p.note, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, now: Date, approvedAt?: Date | null }} p
 */
export const subSetStatus = (ctx, p) =>
  exec(
    ctx,
    `UPDATE subcontract
        SET status = $1, approved_at = $2, version = version + 1, updated_at = $3
      WHERE $t AND id = $4 AND status = $5`,
    [p.to, p.approvedAt ?? null, p.now, p.id, p.from],
  )

// ── subcontract_progress ────────────────────────────────────────────────────
const PROG_COLS = 'id, subcontract_id, seq, amount, status, note, approved_at, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const progressById = (ctx, id) => one(ctx, `SELECT ${PROG_COLS} FROM subcontract_progress WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} subcontractId */
export const progressOf = (ctx, subcontractId) =>
  q(
    ctx,
    `SELECT ${PROG_COLS} FROM subcontract_progress WHERE $t AND subcontract_id = $1 ORDER BY seq ASC`,
    [subcontractId],
  )

/** @param {any} ctx @param {string} subcontractId */
export const progressSum = (ctx, subcontractId) =>
  one(
    ctx,
    `SELECT COALESCE(SUM(amount), 0) AS total FROM subcontract_progress WHERE $t AND subcontract_id = $1`,
    [subcontractId],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, subcontractId: string, seq: number, amount: string, status: string, note: string | null, now: Date }} p
 */
export const progressInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO subcontract_progress (tenant_id, id, subcontract_id, seq, amount, status, note, approved_at, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 1, $8, $8)`,
    [ctx.tenantId, p.id, p.subcontractId, p.seq, p.amount, p.status, p.note, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, now: Date, approvedAt?: Date | null }} p
 */
export const progressSetStatus = (ctx, p) =>
  exec(
    ctx,
    `UPDATE subcontract_progress
        SET status = $1, approved_at = $2, version = version + 1, updated_at = $3
      WHERE $t AND id = $4 AND status = $5`,
    [p.to, p.approvedAt ?? null, p.now, p.id, p.from],
  )

// ── invoice ─────────────────────────────────────────────────────────────────
const INV_COLS =
  'id, kind, party_id, project_id, contract_id, po_id, subcontract_id, code, amount, status, issued_at, note, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const invoiceById = (ctx, id) => one(ctx, `SELECT ${INV_COLS} FROM invoice WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const invoiceByCode = (ctx, code) => one(ctx, `SELECT ${INV_COLS} FROM invoice WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, kind?: string, projectId?: string, partyId?: string, status?: string }} f
 */
export function invoiceList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  for (const [col, val] of [
    ['kind', f.kind],
    ['project_id', f.projectId],
    ['party_id', f.partyId],
    ['status', f.status],
  ]) {
    if (!val) continue
    args.push(val)
    conds.push(`${col} = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${INV_COLS} FROM invoice WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, kind: string, partyId: string, projectId: string | null, contractId: string | null, poId: string | null, subcontractId: string | null, code: string, amount: string, status: string, issuedAt: Date, note: string | null, now: Date }} p
 */
export const invoiceInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO invoice (tenant_id, id, kind, party_id, project_id, contract_id, po_id, subcontract_id, code, amount, status, issued_at, note, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1, $14, $14)`,
    [
      ctx.tenantId,
      p.id,
      p.kind,
      p.partyId,
      p.projectId,
      p.contractId,
      p.poId,
      p.subcontractId,
      p.code,
      p.amount,
      p.status,
      p.issuedAt,
      p.note,
      p.now,
    ],
  )

// ── ar_ledger / ap_ledger ───────────────────────────────────────────────────
const AR_COLS =
  'id, party_id, project_id, contract_id, invoice_id, entry_type, amount, ref_type, ref_id, note, at, created_at'

/** @param {any} ctx @param {string} id */
export const arById = (ctx, id) => one(ctx, `SELECT ${AR_COLS} FROM ar_ledger WHERE $t AND id = $1`, [id])
const AP_COLS =
  'id, party_id, project_id, po_id, subcontract_id, invoice_id, entry_type, amount, ref_type, ref_id, note, at, created_at'

/**
 * @param {any} ctx
 * @param {{ id: string, partyId: string, projectId: string | null, contractId: string | null, invoiceId: string | null, entryType: string, amount: string, refType: string | null, refId: string | null, note: string | null, at: Date }} p
 */
export const arInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO ar_ledger (tenant_id, id, party_id, project_id, contract_id, invoice_id, entry_type, amount, ref_type, ref_id, note, at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      ctx.tenantId,
      p.id,
      p.partyId,
      p.projectId,
      p.contractId,
      p.invoiceId,
      p.entryType,
      p.amount,
      p.refType,
      p.refId,
      p.note,
      p.at,
    ],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, partyId: string, projectId: string | null, poId: string | null, subcontractId: string | null, invoiceId: string | null, entryType: string, amount: string, refType: string | null, refId: string | null, note: string | null, at: Date }} p
 */
export const apInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO ap_ledger (tenant_id, id, party_id, project_id, po_id, subcontract_id, invoice_id, entry_type, amount, ref_type, ref_id, note, at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
    [
      ctx.tenantId,
      p.id,
      p.partyId,
      p.projectId,
      p.poId,
      p.subcontractId,
      p.invoiceId,
      p.entryType,
      p.amount,
      p.refType,
      p.refId,
      p.note,
      p.at,
    ],
  )

/**
 * 台账列表 + 余额过滤共用同一套条件（表名保持字面量，租户守卫要求能看见 $t）。
 * @param {any} ctx
 * @param {{ partyId?: string, projectId?: string, contractId?: string, poId?: string, subcontractId?: string, limit?: number, order?: 'asc'|'desc', cursor?: { at: Date, id: string } | null }} f
 */
function ledgerQuery(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  const args = []
  for (const [col, val] of [
    ['party_id', f.partyId],
    ['project_id', f.projectId],
    ['contract_id', f.contractId],
    ['po_id', f.poId],
    ['subcontract_id', f.subcontractId],
  ]) {
    if (!val) continue
    args.push(val)
    conds.push(`${col} = $${args.length}`)
  }
  return { conds, args }
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, partyId?: string, projectId?: string, contractId?: string }} f
 */
export function arList(ctx, f) {
  const { conds, args: base } = ledgerQuery(ctx, f)
  const cur = cursorClause(f.cursor, base, f.order, 'at')
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  const args = [...cur.args, f.limit + 1]
  const sql =
    `SELECT ${AR_COLS} FROM ar_ledger WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, partyId?: string, projectId?: string, poId?: string, subcontractId?: string }} f
 */
export function apList(ctx, f) {
  const { conds, args: base } = ledgerQuery(ctx, f)
  const cur = cursorClause(f.cursor, base, f.order, 'at')
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  const args = [...cur.args, f.limit + 1]
  const sql =
    `SELECT ${AP_COLS} FROM ap_ledger WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * 余额 = SUM(amount)，正数=还欠着。收款/付款前用它做超额校验。
 * @param {any} ctx
 * @param {'ar'|'ap'} kind
 * @param {{ partyId?: string, projectId?: string }} f
 */
export async function ledgerBalance(ctx, kind, f) {
  const { conds, args } = ledgerQuery(ctx, f)
  const tail = conds.length ? ` AND ${conds.join(' AND ')}` : ''
  // 表名与 $t 必须是同一段字面量：租户守卫会拒绝动态表名（否则无法静态确认每条语句都带 $t）
  const row =
    kind === 'ar'
      ? await one(ctx, `SELECT COALESCE(SUM(amount), 0) AS balance FROM ar_ledger WHERE $t${tail}`, args)
      : await one(ctx, `SELECT COALESCE(SUM(amount), 0) AS balance FROM ap_ledger WHERE $t${tail}`, args)
  return String(row?.balance ?? 0)
}

// ── payment ─────────────────────────────────────────────────────────────────
const PAY_COLS = 'id, kind, party_id, project_id, amount, method, paid_at, note, version, created_by, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const paymentById = (ctx, id) => one(ctx, `SELECT ${PAY_COLS} FROM payment WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, kind?: string, partyId?: string, projectId?: string }} f
 */
export function paymentList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  for (const [col, val] of [
    ['kind', f.kind],
    ['party_id', f.partyId],
    ['project_id', f.projectId],
  ]) {
    if (!val) continue
    args.push(val)
    conds.push(`${col} = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${PAY_COLS} FROM payment WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, kind: string, partyId: string, projectId: string | null, amount: string, method: string, paidAt: Date, note: string | null, createdBy: string | null, now: Date }} p
 */
export const paymentInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO payment (tenant_id, id, kind, party_id, project_id, amount, method, paid_at, note, version, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11, $11)`,
    [ctx.tenantId, p.id, p.kind, p.partyId, p.projectId, p.amount, p.method, p.paidAt, p.note, p.createdBy, p.now],
  )

// ── cost_line ───────────────────────────────────────────────────────────────
const COST_COLS = 'id, project_id, source, ref_type, ref_id, amount, note, at, created_at'

/** @param {any} ctx @param {string} projectId */
export const costSum = (ctx, projectId) =>
  one(ctx, `SELECT COALESCE(SUM(amount), 0) AS total FROM cost_line WHERE $t AND project_id = $1`, [projectId])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, source?: string }} f
 */
export function costList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.projectId) {
    args.push(f.projectId)
    conds.push(`project_id = $${args.length}`)
  }
  if (f.source) {
    args.push(f.source)
    conds.push(`source = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${COST_COLS} FROM cost_line WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, source: string, refType: string | null, refId: string | null, amount: string, note: string | null, at: Date }} p
 */
export const costInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO cost_line (tenant_id, id, project_id, source, ref_type, ref_id, amount, note, at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [ctx.tenantId, p.id, p.projectId, p.source, p.refType, p.refId, p.amount, p.note, p.at],
  )

// ── 跨域只读（项目 / 合同 / 主数据） ────────────────────────────────────────
// 只读、只带 $t，不碰别的域的表结构/状态机。
/** @param {any} ctx @param {string} id */
export const projectExists = (ctx, id) => one(ctx, `SELECT id FROM project WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} id */
export const partyExists = (ctx, id) => one(ctx, `SELECT id FROM party WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} id */
export const itemExists = (ctx, id) => one(ctx, `SELECT id, name FROM item WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} id */
export const contractById = (ctx, id) =>
  one(ctx, `SELECT id, project_id, party_id, amount, status FROM contract WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} projectId */
export const contractAmountOf = (ctx, projectId) =>
  one(
    ctx,
    `SELECT COALESCE(SUM(amount), 0) AS total FROM contract WHERE $t AND project_id = $1`,
    [projectId],
  )
