import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { centsOf, moneyOf } from '../http/money.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import { nextCode, PREFIX } from './codegen.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/item.mjs'

export const ITEM_STATUSES = ['active', 'disabled']
export const WAREHOUSE_STATUSES = ['active', 'disabled']
export const PRICE_TYPES = ['purchase', 'sale', 'cost']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 */
function assertId(/** @type {string} */ id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** 数量/比率：非负，按「分」精确存储 */
function positiveOf(/** @type {unknown} */ v, /** @type {string} */ field) {
  const cents = centsOf(v, field)
  if (cents <= 0) throw new HttpError(errors.badRequest, { fields: { [field]: 'positive' } })
  return moneyOf(cents)
}

/** 价格/成本：可以为 0 */
function moneyOrZero(/** @type {unknown} */ v, /** @type {string} */ field) {
  const cents = centsOf(v, field)
  if (cents < 0) throw new HttpError(errors.badRequest, { fields: { [field]: 'negative' } })
  return moneyOf(cents)
}

/** @param {unknown} raw */
function dateOf(/** @type {unknown} */ raw, /** @type {string} */ field) {
  if (raw === undefined || raw === null || raw === '') return null
  const d = new Date(String(raw))
  if (Number.isNaN(d.getTime())) throw new HttpError(errors.badRequest, { fields: { [field]: 'time' } })
  return d
}

/** @param {any} r */
export const itemToApi = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  spec: r.spec,
  category: r.category,
  baseUom: r.base_uom,
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const uomToApi = (r) => ({ id: r.id, uom: r.uom, ratio: Number(r.ratio) })

/** @param {any} r */
export const warehouseToApi = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const priceToApi = (r) => ({
  id: r.id,
  itemId: r.item_id,
  priceType: r.price_type,
  price: Number(r.price),
  validFrom: r.valid_from,
  validTo: r.valid_to,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

// ── item ────────────────────────────────────────────────────────────────────
/** @param {any} ctx @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page @param {{ status?: string, category?: string, keyword?: string }} filters */
export async function listItems(ctx, page, filters) {
  const rows = await store.itemList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(itemToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getItem(ctx, id) {
  const row = await store.itemById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const uoms = await store.uomsByItem(ctx, row.id)
  return { ...itemToApi(row), uoms: uoms.map(uomToApi) }
}

/**
 * 子表 UOM 只接受 [{uom, ratio}]，uom 归一为大写，ratio 用「分」存。
 * @param {unknown} raw
 */
function uomsOf(/** @type {unknown} */ raw) {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new HttpError(errors.badRequest, { fields: { uoms: 'type' } })
  /** @type {Set<string>} */
  const seen = new Set()
  return raw.map((x) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      throw new HttpError(errors.badRequest, { fields: { uoms: 'type' } })
    }
    const o = /** @type {Record<string, unknown>} */ (x)
    const extra = Object.keys(o).filter((k) => !['uom', 'ratio'].includes(k))
    if (extra.length) {
      throw new HttpError(errors.badRequest, { reason: `未知字段 ${extra.join(', ')}` })
    }
    const uom = normCode(o.uom)
    if (!/^[A-Z0-9_-]{1,64}$/.test(uom)) {
      throw new HttpError(errors.badRequest, { fields: { uoms: 'uom' } })
    }
    if (seen.has(uom)) throw new HttpError(errors.badRequest, { fields: { uoms: `uom ${uom} 重复` } })
    seen.add(uom)
    return { uom, ratio: positiveOf(o.ratio, 'ratio') }
  })
}

/**
 * @param {any} ctx
 * @param {{ code: string, name: string, spec?: string, category?: string, baseUom: string, status?: string, uoms?: unknown }} input
 */
export async function createItem(ctx, input) {
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.item)
  if (await store.itemByCode(ctx, code)) {
    throw new HttpError(errors.conflict, { reason: `编码 ${code} 已存在` })
  }
  const uoms = uomsOf(input.uoms)
  const now = new Date()
  const id = randomUUID()
  const row = {
    id,
    code,
    name: input.name,
    spec: input.spec ?? null,
    category: input.category ? normCode(input.category) : null,
    baseUom: normCode(input.baseUom),
    status: input.status ?? 'active',
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.itemInsert(tx, row)
    for (const u of uoms ?? []) {
      await store.uomInsert(tx, { id: randomUUID(), itemId: id, uom: u.uom, ratio: u.ratio, now })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'item',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'item',
      refId: id,
      before: null,
      after: { code: row.code, name: row.name, baseUom: row.baseUom, status: row.status },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getItem(ctx, id)
}

/**
 * @param {any} ctx
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updateItem(ctx, id, patch) {
  const cur = await store.itemById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const code = patch.code !== undefined ? normCode(patch.code) : cur.code
  if (code !== cur.code && (await store.itemByCode(ctx, code))) {
    throw new HttpError(errors.conflict, { reason: `编码 ${code} 已存在` })
  }
  const uoms = uomsOf(patch.uoms)
  const now = new Date()
  const row = {
    id,
    expectedVersion: cur.version,
    code,
    name: patch.name ?? cur.name,
    spec: patch.spec !== undefined ? patch.spec : cur.spec,
    category: patch.category !== undefined ? (patch.category ? normCode(patch.category) : null) : cur.category,
    baseUom: patch.baseUom !== undefined ? normCode(patch.baseUom) : cur.base_uom,
    status: patch.status ?? cur.status,
    now,
  }
  await withTx(ctx, async (tx) => {
    const n = await store.itemUpdate(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    if (uoms) {
      await store.uomsRemove(tx, id)
      for (const u of uoms) {
        await store.uomInsert(tx, { id: randomUUID(), itemId: id, uom: u.uom, ratio: u.ratio, now })
      }
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'item',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'item',
      refId: id,
      before: itemToApi(cur),
      after: { code: row.code, name: row.name, baseUom: row.baseUom, status: row.status },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getItem(ctx, id)
}

/** @param {any} ctx @param {string} id */
export async function deleteItem(ctx, id) {
  const cur = await store.itemById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    await store.itemRemove(tx, id)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'item',
      action: 'delete',
      whoId: ctx.userId ?? null,
      refType: 'item',
      refId: id,
      before: itemToApi(cur),
      after: null,
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
}

// ── warehouse ───────────────────────────────────────────────────────────────
/** @param {any} ctx @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page @param {{ status?: string, keyword?: string }} filters */
export async function listWarehouses(ctx, page, filters) {
  const rows = await store.warehouseList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(warehouseToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getWarehouse(ctx, id) {
  const row = await store.warehouseById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return warehouseToApi(row)
}

/**
 * @param {any} ctx
 * @param {{ code: string, name: string, status?: string }} input
 */
export async function createWarehouse(ctx, input) {
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.warehouse)
  if (await store.warehouseByCode(ctx, code)) {
    throw new HttpError(errors.conflict, { reason: `编码 ${code} 已存在` })
  }
  const now = new Date()
  const id = randomUUID()
  const row = { id, code, name: input.name, status: input.status ?? 'active', now }
  await withTx(ctx, async (tx) => {
    await store.warehouseInsert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'warehouse',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'warehouse',
      refId: id,
      before: null,
      after: { code: row.code, name: row.name, status: row.status },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getWarehouse(ctx, id)
}

/**
 * @param {any} ctx
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updateWarehouse(ctx, id, patch) {
  const cur = await store.warehouseById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const code = patch.code !== undefined ? normCode(patch.code) : cur.code
  if (code !== cur.code && (await store.warehouseByCode(ctx, code))) {
    throw new HttpError(errors.conflict, { reason: `编码 ${code} 已存在` })
  }
  const now = new Date()
  const row = {
    id,
    expectedVersion: cur.version,
    code,
    name: patch.name ?? cur.name,
    status: patch.status ?? cur.status,
    now,
  }
  await withTx(ctx, async (tx) => {
    const n = await store.warehouseUpdate(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'warehouse',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'warehouse',
      refId: id,
      before: warehouseToApi(cur),
      after: { code: row.code, name: row.name, status: row.status },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getWarehouse(ctx, id)
}

/** @param {any} ctx @param {string} id */
export async function deleteWarehouse(ctx, id) {
  const cur = await store.warehouseById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    await store.warehouseRemove(tx, id)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'warehouse',
      action: 'delete',
      whoId: ctx.userId ?? null,
      refType: 'warehouse',
      refId: id,
      before: warehouseToApi(cur),
      after: null,
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
}

// ── price_book ──────────────────────────────────────────────────────────────
/** @param {any} ctx @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page @param {{ itemId?: string, priceType?: string }} filters */
export async function listPrices(ctx, page, filters) {
  if (filters.itemId && !UUID.test(filters.itemId)) return { items: [], nextCursor: null }
  const rows = await store.priceList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(priceToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getPrice(ctx, id) {
  const row = await store.priceById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return priceToApi(row)
}

/**
 * @param {any} ctx
 * @param {{ itemId: string, priceType: string, price: unknown, validFrom?: unknown, validTo?: unknown }} input
 */
export async function createPrice(ctx, input) {
  const itemId = assertId(input.itemId)
  if (!(await store.itemById(ctx, itemId))) throw new HttpError(errors.notFound)
  const validFrom = dateOf(input.validFrom, 'validFrom')
  const validTo = dateOf(input.validTo, 'validTo')
  if (validFrom && validTo && validTo < validFrom) {
    throw new HttpError(errors.badRequest, { fields: { validTo: 'before validFrom' } })
  }
  const now = new Date()
  const id = randomUUID()
  const row = {
    id,
    itemId,
    priceType: input.priceType,
    price: moneyOrZero(input.price, 'price'),
    validFrom,
    validTo,
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.priceInsert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'price_book',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'price_book',
      refId: id,
      before: null,
      after: { itemId, priceType: row.priceType, price: row.price },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getPrice(ctx, id)
}

/**
 * @param {any} ctx
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updatePrice(ctx, id, patch) {
  const cur = await store.priceById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const itemId = patch.itemId !== undefined ? assertId(patch.itemId) : cur.item_id
  if (itemId !== cur.item_id && !(await store.itemById(ctx, itemId))) {
    throw new HttpError(errors.notFound)
  }
  const validFrom = patch.validFrom !== undefined ? dateOf(patch.validFrom, 'validFrom') : cur.valid_from
  const validTo = patch.validTo !== undefined ? dateOf(patch.validTo, 'validTo') : cur.valid_to
  if (validFrom && validTo && validTo < validFrom) {
    throw new HttpError(errors.badRequest, { fields: { validTo: 'before validFrom' } })
  }
  const now = new Date()
  const row = {
    id,
    expectedVersion: cur.version,
    itemId,
    priceType: patch.priceType ?? cur.price_type,
    price: patch.price !== undefined ? moneyOrZero(patch.price, 'price') : String(cur.price),
    validFrom,
    validTo,
    now,
  }
  await withTx(ctx, async (tx) => {
    const n = await store.priceUpdate(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'price_book',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'price_book',
      refId: id,
      before: priceToApi(cur),
      after: { itemId, priceType: row.priceType, price: row.price },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getPrice(ctx, id)
}

/** @param {any} ctx @param {string} id */
export async function deletePrice(ctx, id) {
  const cur = await store.priceById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    await store.priceRemove(tx, id)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'price_book',
      action: 'delete',
      whoId: ctx.userId ?? null,
      refType: 'price_book',
      refId: id,
      before: priceToApi(cur),
      after: null,
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
}
