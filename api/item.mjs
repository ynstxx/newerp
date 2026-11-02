import { need } from '../auth/perm.mjs'
import { only, readJson } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as items from '../svc/item.mjs'
import * as stock from '../svc/stock.mjs'

const ITEM_FIELDS = ['code', 'name', 'spec', 'category', 'baseUom', 'status', 'version', 'uoms']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const ITEM_SPEC = {
  code: { type: 'code', required: true, max: 64 },
  name: { type: 'string', required: true, max: 64 },
  spec: { type: 'string', max: 64 },
  category: { type: 'code', max: 64 },
  // 计量单位是自然语言（台/套/米/箱），不是 ASCII 业务编码 —— 用 code 类型会把中文全拒掉
  baseUom: { type: 'string', required: true, max: 32 },
  status: { type: 'enum', values: items.ITEM_STATUSES },
  version: { type: 'int' },
}

const WH_FIELDS = ['code', 'name', 'status', 'version']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const WH_SPEC = {
  code: { type: 'code', required: true, max: 64 },
  name: { type: 'string', required: true, max: 64 },
  status: { type: 'enum', values: items.WAREHOUSE_STATUSES },
  version: { type: 'int' },
}

const PRICE_FIELDS = ['itemId', 'priceType', 'price', 'validFrom', 'validTo', 'version']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PRICE_SPEC = {
  itemId: { type: 'string', required: true, max: 64 },
  priceType: { type: 'enum', values: items.PRICE_TYPES, required: true },
  version: { type: 'int' },
}

const MOVE_FIELDS = ['warehouseId', 'itemId', 'qty', 'dir', 'moveType', 'refType', 'refId', 'unitCost', 'note', 'sns']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const MOVE_SPEC = {
  warehouseId: { type: 'string', required: true, max: 64 },
  itemId: { type: 'string', required: true, max: 64 },
  dir: { type: 'enum', values: stock.MOVE_DIRECTIONS, required: true },
  moveType: { type: 'code', required: true, max: 64 },
  refType: { type: 'code', max: 64 },
  refId: { type: 'string', max: 64 },
  note: { type: 'string', max: 500 },
}

const str = (/** @type {unknown} */ v) => (v === undefined || v === null || v === '' ? undefined : String(v))
const keywordOf = (/** @type {any} */ ctx) => (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined

// ── items ───────────────────────────────────────────────────────────────────
/** @type {import('../http/router.mjs').Handler} */
export async function listItems(ctx) {
  need(ctx, 'item:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await items.listItems(ctx, page, {
      status: str(ctx.url.searchParams.get('status')),
      category: str(ctx.url.searchParams.get('category')),
      keyword: keywordOf(ctx),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getItem(ctx) {
  need(ctx, 'item:view')
  sendJson(ctx.res, 200, await items.getItem(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createItem(ctx) {
  need(ctx, 'item:create')
  const body = only(await readJson(ctx), ITEM_FIELDS)
  const input = validate(body, ITEM_SPEC)
  sendJson(
    ctx.res,
    201,
    await items.createItem(ctx, /** @type {any} */ ({ ...input, uoms: body.uoms })),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateItem(ctx) {
  need(ctx, 'item:update')
  const body = only(await readJson(ctx), ITEM_FIELDS)
  const patch = validate(body, ITEM_SPEC, { partial: true })
  sendJson(
    ctx.res,
    200,
    await items.updateItem(ctx, ctx.params.id, { ...patch, ...(body.uoms !== undefined ? { uoms: body.uoms } : {}) }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function deleteItem(ctx) {
  need(ctx, 'item:delete')
  await items.deleteItem(ctx, ctx.params.id)
  sendJson(ctx.res, 200, { ok: true })
}

// ── warehouses ──────────────────────────────────────────────────────────────
/** @type {import('../http/router.mjs').Handler} */
export async function listWarehouses(ctx) {
  need(ctx, 'warehouse:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await items.listWarehouses(ctx, page, {
      status: str(ctx.url.searchParams.get('status')),
      keyword: keywordOf(ctx),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getWarehouse(ctx) {
  need(ctx, 'warehouse:view')
  sendJson(ctx.res, 200, await items.getWarehouse(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createWarehouse(ctx) {
  need(ctx, 'warehouse:create')
  const body = only(await readJson(ctx), WH_FIELDS)
  const input = validate(body, WH_SPEC)
  sendJson(ctx.res, 201, await items.createWarehouse(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateWarehouse(ctx) {
  need(ctx, 'warehouse:update')
  const body = only(await readJson(ctx), WH_FIELDS)
  const patch = validate(body, WH_SPEC, { partial: true })
  sendJson(ctx.res, 200, await items.updateWarehouse(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function deleteWarehouse(ctx) {
  need(ctx, 'warehouse:delete')
  await items.deleteWarehouse(ctx, ctx.params.id)
  sendJson(ctx.res, 200, { ok: true })
}

// ── price books ─────────────────────────────────────────────────────────────
/** @type {import('../http/router.mjs').Handler} */
export async function listPrices(ctx) {
  need(ctx, 'price:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await items.listPrices(ctx, page, {
      itemId: str(ctx.url.searchParams.get('itemId')),
      priceType: str(ctx.url.searchParams.get('priceType')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getPrice(ctx) {
  need(ctx, 'price:view')
  sendJson(ctx.res, 200, await items.getPrice(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createPrice(ctx) {
  need(ctx, 'price:create')
  const body = only(await readJson(ctx), PRICE_FIELDS)
  const input = validate(body, PRICE_SPEC)
  sendJson(
    ctx.res,
    201,
    await items.createPrice(ctx, {
      itemId: String(input.itemId),
      priceType: String(input.priceType),
      price: body.price,
      validFrom: body.validFrom,
      validTo: body.validTo,
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function updatePrice(ctx) {
  need(ctx, 'price:update')
  const body = only(await readJson(ctx), PRICE_FIELDS)
  const patch = validate(body, PRICE_SPEC, { partial: true })
  /** @type {Record<string, unknown>} */
  const out = { ...patch }
  for (const k of ['price', 'validFrom', 'validTo']) if (body[k] !== undefined) out[k] = body[k]
  sendJson(ctx.res, 200, await items.updatePrice(ctx, ctx.params.id, out))
}

/** @type {import('../http/router.mjs').Handler} */
export async function deletePrice(ctx) {
  need(ctx, 'price:delete')
  await items.deletePrice(ctx, ctx.params.id)
  sendJson(ctx.res, 200, { ok: true })
}

// ── stock ───────────────────────────────────────────────────────────────────
/** @type {import('../http/router.mjs').Handler} */
export async function listMoves(ctx) {
  need(ctx, 'stock:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await stock.movements(ctx, page, {
      warehouseId: str(ctx.url.searchParams.get('warehouseId')),
      itemId: str(ctx.url.searchParams.get('itemId')),
      dir: str(ctx.url.searchParams.get('dir')),
      moveType: str(ctx.url.searchParams.get('moveType')),
      refType: str(ctx.url.searchParams.get('refType')),
      refId: str(ctx.url.searchParams.get('refId')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function createMove(ctx) {
  need(ctx, 'stock:move')
  const body = only(await readJson(ctx), MOVE_FIELDS)
  const input = validate(body, MOVE_SPEC)
  sendJson(
    ctx.res,
    201,
    await stock.applyMove(ctx, {
      warehouseId: String(input.warehouseId),
      itemId: String(input.itemId),
      qty: body.qty,
      dir: /** @type {'in'|'out'} */ (String(input.dir)),
      moveType: String(input.moveType),
      refType: /** @type {string | undefined} */ (input.refType),
      refId: /** @type {string | undefined} */ (input.refId),
      unitCost: body.unitCost,
      note: /** @type {string | undefined} */ (input.note),
      sns: body.sns,
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function listBalances(ctx) {
  need(ctx, 'stock:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await stock.listBalances(ctx, page, {
      warehouseId: str(ctx.url.searchParams.get('warehouseId')),
      itemId: str(ctx.url.searchParams.get('itemId')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function traceSn(ctx) {
  need(ctx, 'stock:view')
  sendJson(ctx.res, 200, await stock.snTrace(ctx, ctx.params.sn))
}
