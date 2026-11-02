import { need } from '../auth/perm.mjs'
import { only, readJson } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/purchase.mjs'

/**
 * M4 采购与财务的 HTTP 层：只做权限、字段白名单、分页解析，业务在 svc/purchase.mjs。
 * 金额/数量原样透传给 svc（按「分」整数算）；未知字段由 only() 挡成 400。
 */

const str = (/** @type {unknown} */ v) => (v === undefined || v === null || v === '' ? undefined : String(v))
const keywordOf = (/** @type {any} */ ctx) => (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined

// ── purchase orders ─────────────────────────────────────────────────────────
const PO_FIELDS = ['projectId', 'partyId', 'code', 'note', 'lines']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PO_SPEC = {
  projectId: { type: 'string', max: 64 },
  partyId: { type: 'string', required: true, max: 64 },
  // 留空自动生成：PREFIX-YYYY-0001
  code: { type: 'code', max: 64 },
  note: { type: 'string', max: 500 },
}

const PO_PATCH_FIELDS = ['note', 'version']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PO_PATCH_SPEC = {
  note: { type: 'string', max: 500 },
  version: { type: 'int' },
}

const VERSION_FIELDS = ['version']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const VERSION_SPEC = { version: { type: 'int' } }

/** @type {import('../http/router.mjs').Handler} */
export async function listPOs(ctx) {
  need(ctx, 'purchase:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await svc.listPos(ctx, page, {
      projectId: str(ctx.url.searchParams.get('projectId')),
      partyId: str(ctx.url.searchParams.get('partyId')),
      status: str(ctx.url.searchParams.get('status')),
      keyword: keywordOf(ctx),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function createPO(ctx) {
  need(ctx, 'purchase:create')
  const body = only(await readJson(ctx), PO_FIELDS)
  const input = validate(body, PO_SPEC)
  sendJson(
    ctx.res,
    201,
    await svc.createPo(ctx, /** @type {any} */ ({ ...input, lines: body.lines })),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getPO(ctx) {
  need(ctx, 'purchase:view')
  sendJson(ctx.res, 200, await svc.getPo(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updatePO(ctx) {
  need(ctx, 'purchase:update')
  const body = only(await readJson(ctx), PO_PATCH_FIELDS)
  const patch = validate(body, PO_PATCH_SPEC, { partial: true })
  sendJson(ctx.res, 200, await svc.updatePo(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function submitPO(ctx) {
  need(ctx, 'purchase:create')
  const body = only(await readJson(ctx), VERSION_FIELDS)
  const input = validate(body, VERSION_SPEC, { partial: true })
  sendJson(ctx.res, 200, await svc.submitPo(ctx, ctx.params.id, input))
}

// ── goods receipts ──────────────────────────────────────────────────────────
const RECEIPT_FIELDS = ['poId', 'warehouseId', 'code', 'note', 'receivedAt', 'lines']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const RECEIPT_SPEC = {
  poId: { type: 'string', required: true, max: 64 },
  warehouseId: { type: 'string', required: true, max: 64 },
  code: { type: 'code', max: 64 },
  note: { type: 'string', max: 500 },
  receivedAt: { type: 'string', max: 64 },
}

/** @type {import('../http/router.mjs').Handler} */
export async function listReceipts(ctx) {
  need(ctx, 'purchase:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await svc.listReceipts(ctx, page, {
      poId: str(ctx.url.searchParams.get('poId')),
      warehouseId: str(ctx.url.searchParams.get('warehouseId')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function createReceipt(ctx) {
  need(ctx, 'purchase:create')
  const body = only(await readJson(ctx), RECEIPT_FIELDS)
  const input = validate(body, RECEIPT_SPEC)
  sendJson(
    ctx.res,
    201,
    await svc.createReceipt(ctx, /** @type {any} */ ({ ...input, lines: body.lines })),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getReceipt(ctx) {
  need(ctx, 'purchase:view')
  sendJson(ctx.res, 200, await svc.getReceipt(ctx, ctx.params.id))
}

// ── subcontracts ────────────────────────────────────────────────────────────
const SUB_FIELDS = ['projectId', 'partyId', 'code', 'name', 'amount', 'note']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SUB_SPEC = {
  projectId: { type: 'string', required: true, max: 64 },
  partyId: { type: 'string', required: true, max: 64 },
  // 留空自动生成：PREFIX-YYYY-0001
  code: { type: 'code', max: 64 },
  name: { type: 'string', required: true, max: 64 },
  note: { type: 'string', max: 500 },
}

const PROGRESS_FIELDS = ['seq', 'amount', 'note']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PROGRESS_SPEC = {
  seq: { type: 'int', required: true },
  note: { type: 'string', max: 500 },
}

/** @type {import('../http/router.mjs').Handler} */
export async function listSubcontracts(ctx) {
  need(ctx, 'subcontract:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await svc.listSubcontracts(ctx, page, {
      projectId: str(ctx.url.searchParams.get('projectId')),
      partyId: str(ctx.url.searchParams.get('partyId')),
      status: str(ctx.url.searchParams.get('status')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function createSubcontract(ctx) {
  need(ctx, 'subcontract:create')
  const body = only(await readJson(ctx), SUB_FIELDS)
  const input = validate(body, SUB_SPEC)
  sendJson(
    ctx.res,
    201,
    await svc.createSubcontract(ctx, /** @type {any} */ ({ ...input, amount: body.amount })),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getSubcontract(ctx) {
  need(ctx, 'subcontract:view')
  sendJson(ctx.res, 200, await svc.getSubcontract(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function submitSubcontract(ctx) {
  need(ctx, 'subcontract:create')
  const body = only(await readJson(ctx), VERSION_FIELDS)
  const input = validate(body, VERSION_SPEC, { partial: true })
  sendJson(ctx.res, 200, await svc.submitSubcontract(ctx, ctx.params.id, input))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createProgress(ctx) {
  need(ctx, 'subcontract:create')
  const body = only(await readJson(ctx), PROGRESS_FIELDS)
  const input = validate(body, PROGRESS_SPEC)
  sendJson(
    ctx.res,
    201,
    await svc.createProgress(ctx, ctx.params.id, /** @type {any} */ ({ ...input, amount: body.amount })),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getProgress(ctx) {
  need(ctx, 'subcontract:view')
  sendJson(ctx.res, 200, await svc.getProgress(ctx, ctx.params.progressId))
}

/** @type {import('../http/router.mjs').Handler} */
export async function submitProgress(ctx) {
  need(ctx, 'subcontract:create')
  const body = only(await readJson(ctx), VERSION_FIELDS)
  const input = validate(body, VERSION_SPEC, { partial: true })
  sendJson(ctx.res, 200, await svc.submitProgress(ctx, ctx.params.id, ctx.params.progressId, input))
}

// ── invoices ────────────────────────────────────────────────────────────────
const INVOICE_FIELDS = [
  'kind',
  'partyId',
  'code',
  'amount',
  'projectId',
  'contractId',
  'poId',
  'subcontractId',
  'issuedAt',
  'note',
]
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const INVOICE_SPEC = {
  kind: { type: 'enum', values: svc.INVOICE_KINDS, required: true },
  partyId: { type: 'string', required: true, max: 64 },
  // 留空自动生成：PREFIX-YYYY-0001
  code: { type: 'code', max: 64 },
  projectId: { type: 'string', max: 64 },
  contractId: { type: 'string', max: 64 },
  poId: { type: 'string', max: 64 },
  subcontractId: { type: 'string', max: 64 },
  issuedAt: { type: 'string', max: 64 },
  note: { type: 'string', max: 500 },
}

/** @type {import('../http/router.mjs').Handler} */
export async function listInvoices(ctx) {
  need(ctx, 'invoice:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await svc.listInvoices(ctx, page, {
      kind: str(ctx.url.searchParams.get('kind')),
      projectId: str(ctx.url.searchParams.get('projectId')),
      partyId: str(ctx.url.searchParams.get('partyId')),
      status: str(ctx.url.searchParams.get('status')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function createInvoice(ctx) {
  need(ctx, 'invoice:create')
  const body = only(await readJson(ctx), INVOICE_FIELDS)
  const input = validate(body, INVOICE_SPEC)
  sendJson(
    ctx.res,
    201,
    await svc.createInvoice(ctx, /** @type {any} */ ({ ...input, amount: body.amount })),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getInvoice(ctx) {
  need(ctx, 'invoice:view')
  sendJson(ctx.res, 200, await svc.getInvoice(ctx, ctx.params.id))
}

// ── payments ────────────────────────────────────────────────────────────────
const PAYMENT_FIELDS = ['kind', 'partyId', 'amount', 'projectId', 'method', 'paidAt', 'note']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PAYMENT_SPEC = {
  kind: { type: 'enum', values: svc.PAYMENT_KINDS, required: true },
  partyId: { type: 'string', required: true, max: 64 },
  projectId: { type: 'string', max: 64 },
  method: { type: 'enum', values: svc.PAYMENT_METHODS },
  paidAt: { type: 'string', max: 64 },
  note: { type: 'string', max: 500 },
}

/** @type {import('../http/router.mjs').Handler} */
export async function listPayments(ctx) {
  need(ctx, 'payment:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await svc.listPayments(ctx, page, {
      kind: str(ctx.url.searchParams.get('kind')),
      partyId: str(ctx.url.searchParams.get('partyId')),
      projectId: str(ctx.url.searchParams.get('projectId')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function createPayment(ctx) {
  need(ctx, 'payment:create')
  const body = only(await readJson(ctx), PAYMENT_FIELDS)
  const input = validate(body, PAYMENT_SPEC)
  sendJson(
    ctx.res,
    201,
    await svc.createPayment(ctx, /** @type {any} */ ({ ...input, amount: body.amount })),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getPayment(ctx) {
  need(ctx, 'payment:view')
  sendJson(ctx.res, 200, await svc.getPayment(ctx, ctx.params.id))
}

// ── ar / ap ledger ──────────────────────────────────────────────────────────
const AR_FIELDS = ['contractId', 'amount', 'note']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const AR_SPEC = {
  contractId: { type: 'string', required: true, max: 64 },
  note: { type: 'string', max: 500 },
}

/** @type {import('../http/router.mjs').Handler} */
export async function listAR(ctx) {
  need(ctx, 'invoice:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await svc.listReceivables(ctx, page, {
      partyId: str(ctx.url.searchParams.get('partyId')),
      projectId: str(ctx.url.searchParams.get('projectId')),
      contractId: str(ctx.url.searchParams.get('contractId')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function createAR(ctx) {
  need(ctx, 'invoice:create')
  const body = only(await readJson(ctx), AR_FIELDS)
  const input = validate(body, AR_SPEC)
  sendJson(
    ctx.res,
    201,
    await svc.createReceivable(ctx, /** @type {any} */ ({ ...input, amount: body.amount })),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function arBalance(ctx) {
  need(ctx, 'invoice:view')
  sendJson(
    ctx.res,
    200,
    await svc.balance(ctx, 'ar', {
      partyId: str(ctx.url.searchParams.get('partyId')),
      projectId: str(ctx.url.searchParams.get('projectId')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function listAP(ctx) {
  need(ctx, 'payment:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await svc.listPayables(ctx, page, {
      partyId: str(ctx.url.searchParams.get('partyId')),
      projectId: str(ctx.url.searchParams.get('projectId')),
      poId: str(ctx.url.searchParams.get('poId')),
      subcontractId: str(ctx.url.searchParams.get('subcontractId')),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function apBalance(ctx) {
  need(ctx, 'payment:view')
  sendJson(
    ctx.res,
    200,
    await svc.balance(ctx, 'ap', {
      partyId: str(ctx.url.searchParams.get('partyId')),
      projectId: str(ctx.url.searchParams.get('projectId')),
    }),
  )
}

// ── cost + profit ───────────────────────────────────────────────────────────
/** @type {import('../http/router.mjs').Handler} */
export async function listCosts(ctx) {
  need(ctx, 'cost:view')
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  sendJson(
    ctx.res,
    200,
    await svc.listCosts(ctx, page, {
      projectId: str(ctx.url.searchParams.get('projectId')),
      source: str(ctx.url.searchParams.get('source')),
    }),
  )
}

/** M4 唯一验收点：项目毛利。 @type {import('../http/router.mjs').Handler} */
export async function projectProfit(ctx) {
  need(ctx, 'project:view')
  sendJson(ctx.res, 200, await svc.projectProfit(ctx, ctx.params.id))
}
