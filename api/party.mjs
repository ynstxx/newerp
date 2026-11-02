import { need, PERM } from '../auth/perm.mjs'
import { readJson, only } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/party.mjs'

const FIELDS = ['code', 'name', 'partyType', 'taxNo', 'contactName', 'phone', 'email', 'addr', 'status', 'remark', 'version']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SPEC = {
  code: { type: 'code', required: true, max: 64 },
  name: { type: 'string', required: true, max: 64 },
  partyType: { type: 'enum', values: svc.PARTY_TYPES, required: true },
  taxNo: { type: 'string', max: 32 },
  contactName: { type: 'string', max: 32 },
  phone: { type: 'string', max: 32 },
  email: { type: 'email' },
  addr: { type: 'string', max: 200 },
  status: { type: 'enum', values: svc.PARTY_STATUSES },
  remark: { type: 'string', max: 500 },
  version: { type: 'int' },
}

/** @type {import('../http/router.mjs').Handler} */
export async function list(ctx) {
  need(ctx, PERM.partyView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const partyType = ctx.url.searchParams.get('partyType') ?? undefined
  const keyword = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined
  sendJson(ctx.res, 200, await svc.listParties(ctx, page, { partyType, keyword }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function get(ctx) {
  need(ctx, PERM.partyView)
  sendJson(ctx.res, 200, await svc.getParty(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function create(ctx) {
  need(ctx, PERM.partyCreate)
  const body = only(await readJson(ctx), FIELDS)
  const input = validate(body, SPEC)
  sendJson(ctx.res, 201, await svc.createParty(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function update(ctx) {
  need(ctx, PERM.partyUpdate)
  const body = only(await readJson(ctx), FIELDS)
  const patch = validate(body, SPEC, { partial: true })
  sendJson(ctx.res, 200, await svc.updateParty(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function remove(ctx) {
  need(ctx, PERM.partyDelete)
  await svc.deleteParty(ctx, ctx.params.id)
  sendJson(ctx.res, 200, { ok: true })
}
