import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { centsOf, moneyOf } from '../http/money.mjs'
import { trimPage } from '../http/page.mjs'
import * as audit from '../store/audit.mjs'
import * as itemStore from '../store/item.mjs'
import * as store from '../store/stock.mjs'

/**
 * 库存唯一记账入口。
 *
 * 采购入库、领料出库、售后换件……所有切片都必须调 applyMove，
 * 不允许各自 UPDATE stock_bin —— 否则「流水 + 余额 + SN」三件事迟早对不上。
 *
 * 并发写法（双库等权）：
 *   1. 事务内 `SELECT ... FROM item ... FOR UPDATE` 锁物料行，把同一物料的记账串行化；
 *   2. 入库先 `UPDATE stock_bin SET qty = qty + $1`，影响 0 行才 `INSERT`；
 *      不使用 `ON DUPLICATE KEY` / `ON CONFLICT`（DESIGN §6.2 禁 upsert）。
 *   3. 出库 `UPDATE ... WHERE qty >= $1`，影响 0 行 = 余额不足，绝不扣成负数。
 */

export const MOVE_DIRECTIONS = ['in', 'out']
export const SN_STATUSES = ['in_stock', 'issued']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE = /^[A-Za-z0-9_-]{1,64}$/
const SN = /^[A-Za-z0-9._-]{1,64}$/

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 */
function assertId(/** @type {string} */ id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** @param {any} r */
export const moveToApi = (r) => ({
  id: r.id,
  warehouseId: r.warehouse_id,
  itemId: r.item_id,
  qty: Number(r.qty),
  dir: r.dir,
  moveType: r.move_type,
  refType: r.ref_type,
  refId: r.ref_id,
  sns: r.sn_list ? String(r.sn_list).split('|').filter(Boolean) : [],
  unitCost: r.unit_cost === null || r.unit_cost === undefined ? null : Number(r.unit_cost),
  note: r.note,
  at: r.at,
})

/** @param {any} r */
export const snToApi = (r) => ({
  id: r.id,
  itemId: r.item_id,
  sn: r.sn,
  warehouseId: r.warehouse_id,
  status: r.status,
  refType: r.ref_type,
  refId: r.ref_id,
  createdAt: r.created_at,
})

/** @param {any} r */
export const binToApi = (r) => ({
  id: r.id,
  warehouseId: r.warehouse_id,
  itemId: r.item_id,
  qty: Number(r.qty),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {unknown} raw */
function snsOf(/** @type {unknown} */ raw) {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw)) throw new HttpError(errors.badRequest, { fields: { sns: 'type' } })
  /** @type {Set<string>} */
  const seen = new Set()
  return raw.map((x) => {
    if (typeof x !== 'string' || !SN.test(x.trim())) {
      throw new HttpError(errors.badRequest, { fields: { sns: 'code' } })
    }
    // 统一大写：PG 的 COLLATE "C" 大小写敏感，MySQL 默认不敏感，
    // 不归一的话两库对 uniq(sn) 的判断会不一致。
    const sn = x.trim().toUpperCase()
    if (seen.has(sn)) throw new HttpError(errors.badRequest, { fields: { sns: `SN ${sn} 重复` } })
    seen.add(sn)
    return sn
  })
}

/** @param {unknown} raw @param {string} field */
function codeOf(/** @type {unknown} */ raw, /** @type {string} */ field) {
  if (raw === undefined || raw === null || raw === '') return null
  const s = String(raw).trim()
  if (!CODE.test(s)) throw new HttpError(errors.badRequest, { fields: { [field]: 'code' } })
  return s
}

/**
 * 记账。同事务写 stock_move + 更新 stock_bin；sns 给了就登记/核销 item_sn。
 * @param {any} ctx
 * @param {{ warehouseId: string, itemId: string, qty: unknown, dir: 'in'|'out', moveType: string, refType?: string, refId?: string, unitCost?: unknown, note?: string, sns?: unknown }} input
 * @returns {Promise<{ move: any, balance: number }>}
 */
export async function applyMove(ctx, input) {
  const warehouseId = assertId(input.warehouseId)
  const itemId = assertId(input.itemId)
  const dir = input.dir
  if (!MOVE_DIRECTIONS.includes(dir)) {
    throw new HttpError(errors.badRequest, { fields: { dir: `enum:${MOVE_DIRECTIONS.join('|')}` } })
  }
  const cents = centsOf(input.qty, 'qty')
  if (cents <= 0) throw new HttpError(errors.badRequest, { fields: { qty: 'positive' } })
  const qty = moneyOf(cents)
  const moveType = codeOf(input.moveType, 'moveType')
  if (!moveType) throw new HttpError(errors.badRequest, { fields: { moveType: 'required' } })
  const refType = codeOf(input.refType, 'refType')
  const refId = input.refId === undefined || input.refId === null || input.refId === '' ? null : String(input.refId).trim().slice(0, 64)
  const unitCostCents = input.unitCost === undefined || input.unitCost === null ? null : centsOf(input.unitCost, 'unitCost')
  if (unitCostCents !== null && unitCostCents < 0) {
    throw new HttpError(errors.badRequest, { fields: { unitCost: 'negative' } })
  }
  const unitCost = unitCostCents === null ? null : moneyOf(unitCostCents)
  const sns = snsOf(input.sns)
  const now = new Date()
  const moveId = randomUUID()

  return withTx(ctx, async (tx) => {
    // ① 锁物料行：同一物料的并发出入库串行化（跨仓库也串行，换来的实现足够简单）
    if (!(await itemStore.lockItem(tx, itemId))) throw new HttpError(errors.notFound)
    if (!(await itemStore.warehouseById(tx, warehouseId))) throw new HttpError(errors.notFound)

    // ② 余额：出库带 qty >= 条件，入库先 UPDATE 再按需 INSERT
    if (dir === 'out') {
      const n = await store.binTake(tx, { warehouseId, itemId, qty, now })
      if (!n) {
        const bin = await store.binOf(tx, warehouseId, itemId)
        throw new HttpError(errors.conflict, {
          reason: '库存不足',
          available: Number(bin?.qty ?? 0),
        })
      }
    } else {
      const n = await store.binAdd(tx, { warehouseId, itemId, qty, now })
      if (!n) {
        await store.binInsert(tx, { id: randomUUID(), warehouseId, itemId, qty, now })
      }
    }

    // ③ 序列号：入库登记，出库核销（按 SN 行加锁，防止同一 SN 被并发出两次）
    for (const sn of sns ?? []) {
      const cur = await store.lockSn(tx, sn)
      if (dir === 'in') {
        if (cur) throw new HttpError(errors.conflict, { reason: `SN ${sn} 已登记` })
        await store.snInsert(tx, {
          id: randomUUID(),
          itemId,
          sn,
          warehouseId,
          status: 'in_stock',
          refType,
          refId,
          now,
        })
      } else {
        if (!cur) throw new HttpError(errors.conflict, { reason: `SN ${sn} 未登记` })
        if (cur.item_id !== itemId) throw new HttpError(errors.conflict, { reason: `SN ${sn} 不属于该物料` })
        if (cur.status !== 'in_stock') throw new HttpError(errors.conflict, { reason: `SN ${sn} 已出库` })
        await store.snSetStatus(tx, { id: cur.id, status: 'issued', refType, refId })
      }
    }

    // ④ 流水只增不改；sn_list 供 snTrace 反查
    await store.moveInsert(tx, {
      id: moveId,
      warehouseId,
      itemId,
      qty,
      dir,
      moveType,
      refType,
      refId,
      snList: sns && sns.length ? `|${sns.join('|')}|` : null,
      unitCost,
      note: input.note ?? null,
      at: now,
    })

    const bin = await store.binOf(tx, warehouseId, itemId)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'stock',
      action: dir,
      whoId: ctx.userId ?? null,
      refType: 'stock_move',
      refId: moveId,
      before: null,
      after: { warehouseId, itemId, qty, dir, moveType, refType, refId, sns: sns ?? [] },
      traceId: ctx.requestId ?? '',
      at: now,
    })

    const move = await store.moveById(tx, moveId)
    return { move: moveToApi(move), balance: Number(bin?.qty ?? 0) }
  })
}

/**
 * 单个 (仓库,物料) 余额；没有余额行就是 0。
 * @param {any} ctx @param {string} warehouseId @param {string} itemId
 */
export async function balance(ctx, warehouseId, itemId) {
  const wh = assertId(warehouseId)
  const item = assertId(itemId)
  const row = await store.binOf(ctx, wh, item)
  return { warehouseId: wh, itemId: item, qty: row ? Number(row.qty) : 0 }
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ warehouseId?: string, itemId?: string }} filters
 */
export async function listBalances(ctx, page, filters) {
  if (filters.warehouseId && !UUID.test(filters.warehouseId)) return { items: [], nextCursor: null }
  if (filters.itemId && !UUID.test(filters.itemId)) return { items: [], nextCursor: null }
  const rows = await store.binList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(binToApi), nextCursor }
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ warehouseId?: string, itemId?: string, dir?: string, moveType?: string, refType?: string, refId?: string }} filters
 */
export async function movements(ctx, page, filters) {
  if (filters.warehouseId && !UUID.test(filters.warehouseId)) return { items: [], nextCursor: null }
  if (filters.itemId && !UUID.test(filters.itemId)) return { items: [], nextCursor: null }
  const rows = await store.moveList(ctx, { ...page, ...filters })
  // stock_move 的排序键叫 at；trimPage 认 created_at，这里补一个同值别名
  const { items, nextCursor } = trimPage(
    rows.map((r) => ({ ...r, created_at: r.at })),
    page.limit,
  )
  return { items: items.map(moveToApi), nextCursor }
}

/**
 * 反查一个 SN 的全部流水（售后工单要展示「这台设备从入库到换件」的全过程）。
 * @param {any} ctx @param {string} sn
 */
export async function snTrace(ctx, sn) {
  const key = String(sn ?? '').trim().toUpperCase()
  if (!SN.test(key)) throw new HttpError(errors.notFound)
  const row = await store.snBySn(ctx, key)
  if (!row) throw new HttpError(errors.notFound)
  const moves = await store.movesBySn(ctx, row.item_id, key)
  return { sn: snToApi(row), movements: moves.map(moveToApi) }
}
