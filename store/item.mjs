import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// ── item ────────────────────────────────────────────────────────────────────
const ITEM_COLS = 'id, code, name, spec, category, base_uom, status, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const itemById = (ctx, id) => one(ctx, `SELECT ${ITEM_COLS} FROM item WHERE $t AND id = $1`, [id])

/**
 * 记库存前先锁物料行：同一物料的并发出入库被串行化，
 * stock_bin 的「UPDATE 0 行再 INSERT」才不会撞唯一键。
 * @param {any} ctx @param {string} id
 */
export const lockItem = (ctx, id) => one(ctx, `SELECT id FROM item WHERE $t AND id = $1 FOR UPDATE`, [id])

/** @param {any} ctx @param {string} code */
export const itemByCode = (ctx, code) => one(ctx, `SELECT ${ITEM_COLS} FROM item WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, status?: string, category?: string, keyword?: string }} f
 */
export function itemList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.status) {
    args.push(f.status)
    conds.push(`status = $${args.length}`)
  }
  if (f.category) {
    args.push(f.category)
    conds.push(`category = $${args.length}`)
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
    `SELECT ${ITEM_COLS} FROM item WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, code: string, name: string, spec: string | null, category: string | null, baseUom: string, status: string, now: Date }} p
 */
export const itemInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO item (tenant_id, id, code, name, spec, category, base_uom, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9)`,
    [ctx.tenantId, p.id, p.code, p.name, p.spec, p.category, p.baseUom, p.status, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, code: string, name: string, spec: string | null, category: string | null, baseUom: string, status: string, now: Date }} p
 */
export const itemUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE item
        SET code = $1, name = $2, spec = $3, category = $4, base_uom = $5, status = $6,
            version = version + 1, updated_at = $7
      WHERE $t AND id = $8 AND version = $9`,
    [p.code, p.name, p.spec, p.category, p.baseUom, p.status, p.now, p.id, p.expectedVersion],
  )

/** @param {any} ctx @param {string} id */
export const itemRemove = (ctx, id) => exec(ctx, `DELETE FROM item WHERE $t AND id = $1`, [id])

// ── item_uom ────────────────────────────────────────────────────────────────
const UOM_COLS = 'id, item_id, uom, ratio'

/** @param {any} ctx @param {string} itemId */
export const uomsByItem = (ctx, itemId) =>
  q(ctx, `SELECT ${UOM_COLS} FROM item_uom WHERE $t AND item_id = $1 ORDER BY uom ASC`, [itemId])

/** @param {any} ctx @param {string} itemId */
export const uomsRemove = (ctx, itemId) => exec(ctx, `DELETE FROM item_uom WHERE $t AND item_id = $1`, [itemId])

/**
 * @param {any} ctx
 * @param {{ id: string, itemId: string, uom: string, ratio: string, now: Date }} p
 */
export const uomInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO item_uom (tenant_id, id, item_id, uom, ratio, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.tenantId, p.id, p.itemId, p.uom, p.ratio, p.now],
  )

/** @param {any} ctx @param {string} itemId @param {string} uom */
export const uomByItemUom = (ctx, itemId, uom) =>
  one(ctx, `SELECT ${UOM_COLS} FROM item_uom WHERE $t AND item_id = $1 AND uom = $2`, [itemId, uom])

// ── warehouse ───────────────────────────────────────────────────────────────
const WH_COLS = 'id, code, name, status, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const warehouseById = (ctx, id) => one(ctx, `SELECT ${WH_COLS} FROM warehouse WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const warehouseByCode = (ctx, code) =>
  one(ctx, `SELECT ${WH_COLS} FROM warehouse WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, status?: string, keyword?: string }} f
 */
export function warehouseList(ctx, f) {
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
    `SELECT ${WH_COLS} FROM warehouse WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, code: string, name: string, status: string, now: Date }} p
 */
export const warehouseInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO warehouse (tenant_id, id, code, name, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $6)`,
    [ctx.tenantId, p.id, p.code, p.name, p.status, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, code: string, name: string, status: string, now: Date }} p
 */
export const warehouseUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE warehouse
        SET code = $1, name = $2, status = $3, version = version + 1, updated_at = $4
      WHERE $t AND id = $5 AND version = $6`,
    [p.code, p.name, p.status, p.now, p.id, p.expectedVersion],
  )

/** @param {any} ctx @param {string} id */
export const warehouseRemove = (ctx, id) => exec(ctx, `DELETE FROM warehouse WHERE $t AND id = $1`, [id])

// ── price_book ──────────────────────────────────────────────────────────────
const PRICE_COLS = 'id, item_id, price_type, price, valid_from, valid_to, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const priceById = (ctx, id) => one(ctx, `SELECT ${PRICE_COLS} FROM price_book WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, itemId?: string, priceType?: string }} f
 */
export function priceList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.itemId) {
    args.push(f.itemId)
    conds.push(`item_id = $${args.length}`)
  }
  if (f.priceType) {
    args.push(f.priceType)
    conds.push(`price_type = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${PRICE_COLS} FROM price_book WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, itemId: string, priceType: string, price: string, validFrom: Date | null, validTo: Date | null, now: Date }} p
 */
export const priceInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO price_book (tenant_id, id, item_id, price_type, price, valid_from, valid_to, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
    [ctx.tenantId, p.id, p.itemId, p.priceType, p.price, p.validFrom, p.validTo, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, itemId: string, priceType: string, price: string, validFrom: Date | null, validTo: Date | null, now: Date }} p
 */
export const priceUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE price_book
        SET item_id = $1, price_type = $2, price = $3, valid_from = $4, valid_to = $5,
            version = version + 1, updated_at = $6
      WHERE $t AND id = $7 AND version = $8`,
    [p.itemId, p.priceType, p.price, p.validFrom, p.validTo, p.now, p.id, p.expectedVersion],
  )

/** @param {any} ctx @param {string} id */
export const priceRemove = (ctx, id) => exec(ctx, `DELETE FROM price_book WHERE $t AND id = $1`, [id])
