import { need, PERM } from '../auth/perm.mjs'
import { readJson, only } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/opportunity.mjs'

const FIELDS = ['code', 'name', 'partyId', 'ownerId', 'estAmount', 'expectedSignAt', 'note', 'version']
const CREATE_FIELDS = FIELDS.filter((f) => f !== 'version')

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SPEC = {
  code: { type: 'code', required: true, max: 64 },
  name: { type: 'string', required: true, max: 64 },
  partyId: { type: 'string', required: true, max: 36 },
  ownerId: { type: 'string', max: 36 },
  expectedSignAt: { type: 'string', max: 40 },
  note: { type: 'string', max: 500 },
  version: { type: 'int' },
}

/**
 * 金额入参：number 或数字字符串都收，落库前统一成两位小数字符串（numeric 两库都认）。
 * @param {unknown} v
 * @param {string} field
 * @param {boolean} [required]
 */
function moneyOf(v, field, required = false) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(errors.badRequest, { fields: { [field]: 'required' } })
    return undefined
  }
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  if (!Number.isFinite(n)) throw new HttpError(errors.badRequest, { fields: { [field]: 'money' } })
  if (n < 0) throw new HttpError(errors.badRequest, { fields: { [field]: 'min:0' } })
  return n.toFixed(2)
}

/** @type {import('../http/router.mjs').Handler} */
export async function list(ctx) {
  need(ctx, PERM.opportunityView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const stage = ctx.url.searchParams.get('stage') ?? undefined
  const keyword = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined
  sendJson(ctx.res, 200, await svc.listOpportunities(ctx, page, { stage, keyword }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function get(ctx) {
  need(ctx, PERM.opportunityView)
  sendJson(ctx.res, 200, await svc.getOpportunity(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function create(ctx) {
  need(ctx, PERM.opportunityCreate)
  const body = only(await readJson(ctx), CREATE_FIELDS)
  const input = validate(body, SPEC)
  input.estAmount = moneyOf(body.estAmount, 'estAmount', true)
  sendJson(ctx.res, 201, await svc.createOpportunity(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function update(ctx) {
  need(ctx, PERM.opportunityUpdate)
  const body = only(await readJson(ctx), FIELDS)
  const patch = validate(body, SPEC, { partial: true })
  if (body.estAmount !== undefined) patch.estAmount = moneyOf(body.estAmount, 'estAmount')
  sendJson(ctx.res, 200, await svc.updateOpportunity(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function advance(ctx) {
  need(ctx, PERM.opportunityUpdate)
  const body = only(await readJson(ctx), ['to', 'note'])
  const input = validate(body, {
    to: { type: 'enum', values: svc.STAGES, required: true },
    note: { type: 'string', max: 500 },
  })
  sendJson(ctx.res, 200, await svc.advanceOpportunity(ctx, ctx.params.id, /** @type {any} */ (input)))
}
