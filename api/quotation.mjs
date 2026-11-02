import { need, PERM } from '../auth/perm.mjs'
import { readJson, only } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/quotation.mjs'

const FIELDS = ['designDocId', 'code', 'validUntil', 'note', 'priceLines']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SPEC = {
  designDocId: { type: 'string', required: true, max: 64 },
  code: { type: 'code', max: 64 },
  validUntil: { type: 'string', max: 40 },
  note: { type: 'string', max: 500 },
}

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const ADVANCE_SPEC = { to: { type: 'enum', values: svc.QUOTATION_STATUSES, required: true } }

/** 时间只接受能被 Date 解析的字符串；传给库的是 Date 对象 */
function dateOf(/** @type {unknown} */ raw) {
  if (raw === undefined) return undefined
  const d = new Date(String(raw))
  if (Number.isNaN(d.getTime())) throw new HttpError(errors.badRequest, { fields: { validUntil: 'time' } })
  return d
}

/** priceLines 只做结构校验（白名单 + lineNo 整数 + 不重复），金额解析交给 svc */
function priceLinesOf(/** @type {unknown} */ raw) {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new HttpError(errors.badRequest, { fields: { priceLines: 'type' } })
  /** @type {Set<number>} */
  const seen = new Set()
  return raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(errors.badRequest, { fields: { priceLines: 'type' } })
    }
    only(/** @type {Record<string, unknown>} */ (item), ['lineNo', 'price'])
    const one = /** @type {Record<string, unknown>} */ (item)
    if (!Number.isInteger(one.lineNo) || /** @type {number} */ (one.lineNo) < 1) {
      throw new HttpError(errors.badRequest, { fields: { priceLines: 'lineNo 必须是正整数' } })
    }
    if (seen.has(/** @type {number} */ (one.lineNo))) {
      throw new HttpError(errors.badRequest, { fields: { priceLines: `lineNo ${one.lineNo} 重复` } })
    }
    seen.add(/** @type {number} */ (one.lineNo))
    return { lineNo: /** @type {number} */ (one.lineNo), price: one.price }
  })
}

/** @type {import('../http/router.mjs').Handler} */
export async function list(ctx) {
  need(ctx, PERM.quotationView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const projectId = ctx.url.searchParams.get('projectId') ?? undefined
  const status = ctx.url.searchParams.get('status') ?? undefined
  const keyword = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined
  sendJson(ctx.res, 200, await svc.listQuotations(ctx, page, { keyword, projectId, status }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function get(ctx) {
  need(ctx, PERM.quotationView)
  sendJson(ctx.res, 200, await svc.getQuotation(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function create(ctx) {
  need(ctx, PERM.quotationCreate)
  const body = only(await readJson(ctx), FIELDS)
  const input = validate(body, SPEC)
  sendJson(
    ctx.res,
    201,
    await svc.createQuotation(ctx, {
      designDocId: String(input.designDocId),
      code: /** @type {string | undefined} */ (input.code),
      validUntil: dateOf(input.validUntil),
      note: /** @type {string | undefined} */ (input.note),
      priceLines: priceLinesOf(body.priceLines),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function advance(ctx) {
  need(ctx, PERM.quotationUpdate)
  const body = only(await readJson(ctx), ['to'])
  const { to } = validate(body, ADVANCE_SPEC)
  sendJson(ctx.res, 200, await svc.advanceQuotation(ctx, ctx.params.id, String(to)))
}
