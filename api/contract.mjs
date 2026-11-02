import { need, PERM } from '../auth/perm.mjs'
import { readJson, only } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/contract.mjs'

const FIELDS = ['quotationId', 'code', 'name', 'signAt', 'note', 'terms']
const TERM_FIELDS = ['seq', 'title', 'content']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SPEC = {
  quotationId: { type: 'string', required: true, max: 36 },
  // 留空自动生成：PREFIX-YYYY-0001
  code: { type: 'code', max: 64 },
  name: { type: 'string', required: true, max: 64 },
  signAt: { type: 'string', max: 40 },
  note: { type: 'string', max: 500 },
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {unknown} raw */
function parseSignAt(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined
  const d = new Date(String(raw))
  if (Number.isNaN(d.getTime())) throw new HttpError(errors.badRequest, { fields: { signAt: 'date' } })
  return d
}

/**
 * terms 是嵌套结构，validate 的窄类型 DSL 不管，单独校验；seq 由服务端按输入顺序从 1 递增。
 * @param {unknown} raw
 * @returns {{ seq: number, title: string, content: string }[]}
 */
function parseTerms(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new HttpError(errors.badRequest, { fields: { terms: 'array' } })
  if (raw.length > 100) throw new HttpError(errors.badRequest, { fields: { terms: 'max:100' } })

  return raw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(errors.badRequest, { fields: { [`terms[${i}]`]: 'object' } })
    }
    const extra = Object.keys(item).filter((k) => !TERM_FIELDS.includes(k))
    if (extra.length) {
      throw new HttpError(errors.badRequest, { reason: `未知字段 terms[${i}].${extra.join(', ')}` })
    }
    const title = String(item.title ?? '').trim()
    const content = String(item.content ?? '').trim()
    if (!title || title.length > 64) {
      throw new HttpError(errors.badRequest, { fields: { [`terms[${i}].title`]: title ? 'max:64' : 'required' } })
    }
    if (!content || content.length > 5000) {
      throw new HttpError(errors.badRequest, { fields: { [`terms[${i}].content`]: content ? 'max:5000' : 'required' } })
    }
    return { seq: i + 1, title, content }
  })
}

/** @type {import('../http/router.mjs').Handler} */
export async function list(ctx) {
  need(ctx, PERM.contractView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const projectId = (ctx.url.searchParams.get('projectId') ?? '').trim() || undefined
  if (projectId && !UUID.test(projectId)) {
    throw new HttpError(errors.badRequest, { fields: { projectId: 'uuid' } })
  }
  const status = (ctx.url.searchParams.get('status') ?? '').trim() || undefined
  if (status && !svc.CONTRACT_STATUSES.includes(status)) {
    throw new HttpError(errors.badRequest, { fields: { status: `enum:${svc.CONTRACT_STATUSES.join('|')}` } })
  }
  const keyword = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined
  sendJson(ctx.res, 200, await svc.listContracts(ctx, page, { keyword, projectId, status }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function get(ctx) {
  need(ctx, PERM.contractView)
  sendJson(ctx.res, 200, await svc.getContract(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function create(ctx) {
  need(ctx, PERM.contractCreate)
  const body = only(await readJson(ctx), FIELDS)
  const input = validate(body, SPEC)
  const terms = parseTerms(body.terms)
  const signAt = parseSignAt(body.signAt)
  const created = await svc.createContract(ctx, /** @type {any} */ ({ ...input, signAt, terms }))
  sendJson(ctx.res, 201, created)
}

/** @type {import('../http/router.mjs').Handler} */
export async function advance(ctx) {
  need(ctx, PERM.contractUpdate)
  const body = only(await readJson(ctx), ['to'])
  const input = validate(body, { to: { type: 'enum', values: svc.CONTRACT_STATUSES, required: true } })
  sendJson(ctx.res, 200, await svc.advanceContract(ctx, ctx.params.id, String(input.to)))
}
