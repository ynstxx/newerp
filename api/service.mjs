import { need } from '../auth/perm.mjs'
import { only, readJson } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { centsOf, moneyOf } from '../http/money.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as contractSvc from '../svc/service_contract.mjs'
import * as maintenanceSvc from '../svc/maintenance.mjs'
import * as slaSvc from '../svc/sla.mjs'
import * as ticketSvc from '../svc/ticket.mjs'

/**
 * 售后域权限串。DESIGN §8 只固定了 ticket:view/create/dispatch，
 * 其余按「模块:动作」补齐；不改 auth/perm.mjs（并行切片契约）。
 */
const P = {
  contractView: 'service_contract:view',
  contractCreate: 'service_contract:create',
  contractUpdate: 'service_contract:update',
  contractDelete: 'service_contract:delete',
  ticketView: 'ticket:view',
  ticketCreate: 'ticket:create',
  ticketUpdate: 'ticket:update',
  ticketDispatch: 'ticket:dispatch',
  ticketSatisfaction: 'ticket:satisfaction',
  maintenanceView: 'maintenance:view',
  maintenanceUpdate: 'maintenance:update',
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * @param {unknown} v
 * @param {string} field
 * @param {boolean} [required]
 */
function uuidOf(v, field, required = false) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(errors.badRequest, { fields: { [field]: 'required' } })
    return undefined
  }
  const s = String(v)
  if (!UUID.test(s)) throw new HttpError(errors.badRequest, { fields: { [field]: 'uuid' } })
  return s
}

/**
 * @param {unknown} v
 * @param {string} field
 * @param {{ required?: boolean }} [opts]
 */
function dateOf(v, field, opts = {}) {
  if (v === undefined) {
    if (opts.required) throw new HttpError(errors.badRequest, { fields: { [field]: 'required' } })
    return undefined
  }
  if (v === null || v === '') return null
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new HttpError(errors.badRequest, { fields: { [field]: 'date' } })
  return d
}

/**
 * @param {unknown} v
 * @param {string} field
 * @param {{ required?: boolean, positive?: boolean }} [opts]
 */
function moneyOfInput(v, field, opts = {}) {
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw new HttpError(errors.badRequest, { fields: { [field]: 'required' } })
    return undefined
  }
  const cents = centsOf(v, field)
  if (cents < 0) throw new HttpError(errors.badRequest, { fields: { [field]: 'min:0' } })
  if (opts.positive && cents === 0) throw new HttpError(errors.badRequest, { fields: { [field]: 'min:1' } })
  return moneyOf(cents)
}

/** @param {any} ctx @param {string} name @param {readonly string[]} values */
function enumParam(ctx, name, values) {
  const raw = (ctx.url.searchParams.get(name) ?? '').trim()
  if (!raw) return undefined
  if (!values.includes(raw)) throw new HttpError(errors.badRequest, { fields: { [name]: `enum:${values.join('|')}` } })
  return raw
}

// ── 服务合同 ────────────────────────────────────────────────────────────────

const CONTRACT_FIELDS = ['code', 'partyId', 'name', 'startAt', 'endAt', 'slaLevel', 'responseMinutes', 'resolveMinutes', 'amount', 'status']
const CONTRACT_UPDATE_FIELDS = [...CONTRACT_FIELDS, 'version']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const CONTRACT_SPEC = {
  // 留空自动生成：PREFIX-YYYY-0001
  code: { type: 'code', max: 64 },
  partyId: { type: 'string', required: true, max: 36 },
  name: { type: 'string', required: true, max: 64 },
  startAt: { type: 'string', max: 40 },
  endAt: { type: 'string', max: 40 },
  slaLevel: { type: 'code', max: 16 },
  responseMinutes: { type: 'int' },
  resolveMinutes: { type: 'int' },
  status: { type: 'enum', values: [...contractSvc.CONTRACT_STATUSES] },
  version: { type: 'int' },
}

/** @param {Record<string, unknown>} body @param {boolean} partial */
function contractInput(body, partial) {
  const v = validate(body, CONTRACT_SPEC, { partial })
  const out = { ...v }
  if (body.startAt !== undefined) out.startAt = dateOf(body.startAt, 'startAt')
  if (body.endAt !== undefined) out.endAt = dateOf(body.endAt, 'endAt')
  if (body.amount !== undefined) out.amount = moneyOfInput(body.amount, 'amount')
  for (const k of ['responseMinutes', 'resolveMinutes']) {
    const n = out[k]
    if (n !== undefined && (typeof n !== 'number' || n < 0 || n > 525600)) {
      throw new HttpError(errors.badRequest, { fields: { [k]: 'range:0-525600' } })
    }
  }
  return out
}

/** @type {import('../http/router.mjs').Handler} */
export async function listContracts(ctx) {
  need(ctx, P.contractView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const status = enumParam(ctx, 'status', contractSvc.CONTRACT_STATUSES)
  const partyId = uuidOf(ctx.url.searchParams.get('partyId'), 'partyId')
  const keyword = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined
  sendJson(ctx.res, 200, await contractSvc.listContracts(ctx, page, { status, partyId, keyword }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function getContract(ctx) {
  need(ctx, P.contractView)
  sendJson(ctx.res, 200, await contractSvc.getContract(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createContract(ctx) {
  need(ctx, P.contractCreate)
  const body = only(await readJson(ctx), CONTRACT_FIELDS)
  const input = contractInput(body, false)
  sendJson(ctx.res, 201, await contractSvc.createContract(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateContract(ctx) {
  need(ctx, P.contractUpdate)
  const body = only(await readJson(ctx), CONTRACT_UPDATE_FIELDS)
  const patch = contractInput(body, true)
  sendJson(ctx.res, 200, await contractSvc.updateContract(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function removeContract(ctx) {
  need(ctx, P.contractDelete)
  sendJson(ctx.res, 200, await contractSvc.removeContract(ctx, ctx.params.id))
}

// ── 工单 ────────────────────────────────────────────────────────────────────

const TICKET_CREATE_FIELDS = ['code', 'contractId', 'partyId', 'title', 'content', 'sn', 'priority', 'reportedAt']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const TICKET_CREATE_SPEC = {
  code: { type: 'code', max: 64 },
  contractId: { type: 'string', max: 36 },
  partyId: { type: 'string', max: 36 },
  title: { type: 'string', required: true, max: 64 },
  content: { type: 'string', max: 5000 },
  sn: { type: 'string', max: 64 },
  priority: { type: 'enum', values: [...ticketSvc.TICKET_PRIORITIES] },
  reportedAt: { type: 'string', max: 40 },
}

/** @type {import('../http/router.mjs').Handler} */
export async function listTickets(ctx) {
  need(ctx, P.ticketView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const status = enumParam(ctx, 'status', ticketSvc.TICKET_STATUSES)
  const priority = enumParam(ctx, 'priority', ticketSvc.TICKET_PRIORITIES)
  const partyId = uuidOf(ctx.url.searchParams.get('partyId'), 'partyId')
  const contractId = uuidOf(ctx.url.searchParams.get('contractId'), 'contractId')
  const sn = (ctx.url.searchParams.get('sn') ?? '').trim().slice(0, 64) || undefined
  const keyword = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined
  sendJson(ctx.res, 200, await ticketSvc.listTickets(ctx, page, { status, priority, partyId, contractId, sn, keyword }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function getTicket(ctx) {
  need(ctx, P.ticketView)
  sendJson(ctx.res, 200, await ticketSvc.getTicket(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createTicket(ctx) {
  need(ctx, P.ticketCreate)
  const body = only(await readJson(ctx), TICKET_CREATE_FIELDS)
  const input = validate(body, TICKET_CREATE_SPEC)
  if (body.contractId !== undefined) input.contractId = uuidOf(body.contractId, 'contractId')
  if (body.partyId !== undefined) input.partyId = uuidOf(body.partyId, 'partyId')
  if (body.reportedAt !== undefined) input.reportedAt = dateOf(body.reportedAt, 'reportedAt')
  if (!input.contractId && !input.partyId) {
    throw new HttpError(errors.badRequest, { fields: { partyId: 'required' } })
  }
  sendJson(ctx.res, 201, await ticketSvc.createTicket(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function advanceTicket(ctx) {
  need(ctx, P.ticketUpdate)
  const body = only(await readJson(ctx), ['to', 'comment', 'version'])
  const input = validate(body, {
    to: { type: 'enum', values: ticketSvc.TICKET_STATUSES, required: true },
    comment: { type: 'string', max: 500 },
    version: { type: 'int' },
  })
  sendJson(ctx.res, 200, await ticketSvc.advanceTicket(ctx, ctx.params.id, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function dispatchTicket(ctx) {
  need(ctx, P.ticketDispatch)
  const body = only(await readJson(ctx), ['engineerId', 'note'])
  const input = validate(body, {
    engineerId: { type: 'string', required: true, max: 36 },
    note: { type: 'string', max: 500 },
  })
  input.engineerId = uuidOf(body.engineerId, 'engineerId', true)
  sendJson(ctx.res, 200, await ticketSvc.dispatchTicket(ctx, ctx.params.id, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function pauseTicket(ctx) {
  need(ctx, P.ticketUpdate)
  const body = only(await readJson(ctx), ['comment'])
  const input = validate(body, { comment: { type: 'string', max: 500 } })
  sendJson(ctx.res, 200, await ticketSvc.pauseTicket(ctx, ctx.params.id, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function resumeTicket(ctx) {
  need(ctx, P.ticketUpdate)
  const body = only(await readJson(ctx), ['comment'])
  const input = validate(body, { comment: { type: 'string', max: 500 } })
  sendJson(ctx.res, 200, await ticketSvc.resumeTicket(ctx, ctx.params.id, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function addSatisfaction(ctx) {
  need(ctx, P.ticketSatisfaction)
  const body = only(await readJson(ctx), ['score', 'comment'])
  const input = validate(body, {
    score: { type: 'int', required: true },
    comment: { type: 'string', max: 1000 },
  })
  sendJson(ctx.res, 200, await ticketSvc.addSatisfaction(ctx, ctx.params.id, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function listSpareParts(ctx) {
  need(ctx, P.ticketView)
  const detail = await ticketSvc.getTicket(ctx, ctx.params.id)
  sendJson(ctx.res, 200, { items: detail.spareParts })
}

/** @type {import('../http/router.mjs').Handler} */
export async function addSparePart(ctx) {
  need(ctx, P.ticketUpdate)
  const body = only(await readJson(ctx), ['itemName', 'qty', 'dir', 'note'])
  const input = validate(body, {
    itemName: { type: 'string', required: true, max: 64 },
    dir: { type: 'enum', values: [...ticketSvc.SPARE_DIRS], required: true },
    note: { type: 'string', max: 500 },
  })
  input.qty = moneyOfInput(body.qty, 'qty', { required: true, positive: true })
  sendJson(ctx.res, 200, await ticketSvc.addSparePart(ctx, ctx.params.id, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function slaOverdue(ctx) {
  need(ctx, P.ticketView)
  sendJson(ctx.res, 200, await slaSvc.overdue(ctx))
}

// ── 巡检 ────────────────────────────────────────────────────────────────────

const PLAN_FIELDS = ['contractId', 'name', 'cronNote', 'nextAt', 'enabled']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PLAN_SPEC = {
  contractId: { type: 'string', max: 36 },
  name: { type: 'string', max: 64 },
  cronNote: { type: 'string', max: 64 },
  nextAt: { type: 'string', max: 40 },
  enabled: { type: 'bool' },
}

/** @param {Record<string, unknown>} body @param {boolean} partial */
function planInput(body, partial) {
  const v = validate(body, PLAN_SPEC, { partial })
  const out = { ...v }
  if (body.contractId !== undefined) out.contractId = uuidOf(body.contractId, 'contractId')
  if (body.nextAt !== undefined) out.nextAt = dateOf(body.nextAt, 'nextAt')
  return out
}

/** @type {import('../http/router.mjs').Handler} */
export async function listPlans(ctx) {
  need(ctx, P.maintenanceView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const contractId = uuidOf(ctx.url.searchParams.get('contractId'), 'contractId')
  const enabledRaw = ctx.url.searchParams.get('enabled')
  const enabled = enabledRaw === null || enabledRaw === '' ? undefined : enabledRaw === 'true'
  const keyword = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined
  sendJson(ctx.res, 200, await maintenanceSvc.listPlans(ctx, page, { contractId, enabled, keyword }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function getPlan(ctx) {
  need(ctx, P.maintenanceView)
  sendJson(ctx.res, 200, await maintenanceSvc.getPlan(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createPlan(ctx) {
  need(ctx, P.maintenanceUpdate)
  const body = only(await readJson(ctx), PLAN_FIELDS)
  const input = planInput(body, false)
  if (!input.contractId) throw new HttpError(errors.badRequest, { fields: { contractId: 'required' } })
  if (!input.name) throw new HttpError(errors.badRequest, { fields: { name: 'required' } })
  sendJson(ctx.res, 201, await maintenanceSvc.createPlan(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updatePlan(ctx) {
  need(ctx, P.maintenanceUpdate)
  const body = only(await readJson(ctx), PLAN_FIELDS)
  const patch = planInput(body, true)
  sendJson(ctx.res, 200, await maintenanceSvc.updatePlan(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function listTasks(ctx) {
  need(ctx, P.maintenanceView)
  sendJson(ctx.res, 200, await maintenanceSvc.listTasks(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createTask(ctx) {
  need(ctx, P.maintenanceUpdate)
  const body = only(await readJson(ctx), ['dueAt', 'assigneeId'])
  const input = validate(body, { dueAt: { type: 'string', required: true, max: 40 }, assigneeId: { type: 'string', max: 36 } })
  input.dueAt = dateOf(body.dueAt, 'dueAt', { required: true })
  if (body.assigneeId !== undefined) input.assigneeId = uuidOf(body.assigneeId, 'assigneeId')
  sendJson(ctx.res, 201, await maintenanceSvc.createTask(ctx, ctx.params.id, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function finishTask(ctx) {
  need(ctx, P.maintenanceUpdate)
  const body = only(await readJson(ctx), ['result'])
  const input = validate(body, { result: { type: 'string', max: 2000 } })
  sendJson(ctx.res, 200, await maintenanceSvc.finishTask(ctx, ctx.params.id, /** @type {any} */ (input)))
}
