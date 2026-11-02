import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

/**
 * 库存余额与流水。
 *
 * 并发约定：applyMove 在同一事务里先 `SELECT ... FROM item WHERE $t AND id=... FOR UPDATE`
 * （见 store/item.mjs 的 lockItem）把同一物料的记账串行化。
 * 因此这里可以安全地「先 UPDATE，影响 0 行再 INSERT」——不引入 upsert 语法，
 * 两库语义完全一致；也不会出现两个事务同时 INSERT 撞 uniq(warehouse_id,item_id)。
 */

const BIN_COLS = 'id, warehouse_id, item_id, qty, created_at, updated_at'

/** @param {any} ctx @param {string} warehouseId @param {string} itemId */
export const binOf = (ctx, warehouseId, itemId) =>
  one(ctx, `SELECT ${BIN_COLS} FROM stock_bin WHERE $t AND warehouse_id = $1 AND item_id = $2`, [
    warehouseId,
    itemId,
  ])

/**
 * 入库增量。返回 0 = 该 (仓库,物料) 还没有余额行，调用方去 INSERT。
 * @param {any} ctx
 * @param {{ warehouseId: string, itemId: string, qty: string, now: Date }} p
 */
export const binAdd = (ctx, p) =>
  exec(
    ctx,
    `UPDATE stock_bin SET qty = qty + $1, updated_at = $2
      WHERE $t AND warehouse_id = $3 AND item_id = $4`,
    [p.qty, p.now, p.warehouseId, p.itemId],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, warehouseId: string, itemId: string, qty: string, now: Date }} p
 */
export const binInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO stock_bin (tenant_id, id, warehouse_id, item_id, qty, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [ctx.tenantId, p.id, p.warehouseId, p.itemId, p.qty, p.now],
  )

/**
 * 出库扣减；`qty >= $1` 是最后一道防线：余额永远扣不成负数。
 * 返回 0 = 余额行不存在或不够，调用方再查一次 available 抛 409。
 * @param {any} ctx
 * @param {{ warehouseId: string, itemId: string, qty: string, now: Date }} p
 */
export const binTake = (ctx, p) =>
  exec(
    ctx,
    `UPDATE stock_bin SET qty = qty - $1, updated_at = $2
      WHERE $t AND warehouse_id = $3 AND item_id = $4 AND qty >= $1`,
    [p.qty, p.now, p.warehouseId, p.itemId],
  )

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, warehouseId?: string, itemId?: string }} f
 */
export function binList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.warehouseId) {
    args.push(f.warehouseId)
    conds.push(`warehouse_id = $${args.length}`)
  }
  if (f.itemId) {
    args.push(f.itemId)
    conds.push(`item_id = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${BIN_COLS} FROM stock_bin WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

const MOVE_COLS =
  'id, warehouse_id, item_id, qty, dir, move_type, ref_type, ref_id, sn_list, unit_cost, note, at'

/**
 * @param {any} ctx
 * @param {{ id: string, warehouseId: string, itemId: string, qty: string, dir: string, moveType: string, refType: string | null, refId: string | null, snList: string | null, unitCost: string | null, note: string | null, at: Date }} p
 */
export const moveInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO stock_move (tenant_id, id, warehouse_id, item_id, qty, dir, move_type, ref_type, ref_id, sn_list, unit_cost, note, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      ctx.tenantId,
      p.id,
      p.warehouseId,
      p.itemId,
      p.qty,
      p.dir,
      p.moveType,
      p.refType,
      p.refId,
      p.snList,
      p.unitCost,
      p.note,
      p.at,
    ],
  )

/** @param {any} ctx @param {string} id */
export const moveById = (ctx, id) => one(ctx, `SELECT ${MOVE_COLS} FROM stock_move WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, warehouseId?: string, itemId?: string, dir?: string, moveType?: string, refType?: string, refId?: string }} f
 */
export function moveList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  for (const [col, val] of [
    ['warehouse_id', f.warehouseId],
    ['item_id', f.itemId],
    ['dir', f.dir],
    ['move_type', f.moveType],
    ['ref_type', f.refType],
    ['ref_id', f.refId],
  ]) {
    if (!val) continue
    args.push(val)
    conds.push(`${col} = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order, 'at')
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${MOVE_COLS} FROM stock_move WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * 一个 SN 的全部流水。sn_list 是 `|SN1|SN2|` 形式的冗余索引串。
 * SN 里允许 `_` / `%`，所以 LIKE 的通配符必须转义（两库都支持 ESCAPE '!'）。
 * @param {any} ctx @param {string} itemId @param {string} sn
 */
export const movesBySn = (ctx, itemId, sn) => {
  const escaped = sn.replace(/[!%_]/g, (c) => `!${c}`)
  return q(
    ctx,
    `SELECT ${MOVE_COLS} FROM stock_move
      WHERE $t AND item_id = $1 AND UPPER(sn_list) LIKE UPPER($2) ESCAPE '!'
      ORDER BY at ASC, id ASC`,
    [itemId, `%|${escaped}|%`],
  )
}

// ── item_sn ─────────────────────────────────────────────────────────────────
const SN_COLS = 'id, item_id, sn, warehouse_id, status, ref_type, ref_id, created_at'

/** @param {any} ctx @param {string} sn */
export const snBySn = (ctx, sn) => one(ctx, `SELECT ${SN_COLS} FROM item_sn WHERE $t AND sn = $1`, [sn])

/** 出库时锁住 SN 行，避免同一序列号被两条流水同时标记
 * @param {any} ctx @param {string} sn */
export const lockSn = (ctx, sn) =>
  one(ctx, `SELECT ${SN_COLS} FROM item_sn WHERE $t AND sn = $1 FOR UPDATE`, [sn])

/**
 * @param {any} ctx
 * @param {{ id: string, itemId: string, sn: string, warehouseId: string, status: string, refType: string | null, refId: string | null, now: Date }} p
 */
export const snInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO item_sn (tenant_id, id, item_id, sn, warehouse_id, status, ref_type, ref_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [ctx.tenantId, p.id, p.itemId, p.sn, p.warehouseId, p.status, p.refType, p.refId, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, status: string, refType: string | null, refId: string | null }} p
 */
export const snSetStatus = (ctx, p) =>
  exec(
    ctx,
    `UPDATE item_sn SET status = $1, ref_type = $2, ref_id = $3 WHERE $t AND id = $4`,
    [p.status, p.refType, p.refId, p.id],
  )
