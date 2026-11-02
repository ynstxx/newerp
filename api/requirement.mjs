import { need, PERM } from '../auth/perm.mjs'
import { readJson, only } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/requirement.mjs'

// requirement 表没有 version 列（schema 不可改），PATCH 里的 version 只为兼容调用方
const CREATE_FIELDS = ['projectId', 'title', 'content']
const PATCH_FIELDS = ['version', 'title', 'content']
const ADVANCE_FIELDS = ['to']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SPEC = {
  projectId: { type: 'string', required: true, max: 64 },
  title: { type: 'string', required: true, max: 64 },
  content: { type: 'string', max: 2000 },
  version: { type: 'int' },
}

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const ADVANCE_SPEC = { to: { type: 'string', required: true, max: 32 } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 查询串里的 id 过滤：非法值直接 400，别让它变成 PG 的类型错误 */
function uuidFilter(/** @type {string | null} */ raw) {
  if (!raw) return undefined
  if (!UUID.test(raw)) throw new HttpError(errors.badRequest, { reason: 'projectId 不是 uuid' })
  return raw
}

/** @param {string | null} raw @param {string[]} values */
function enumFilter(raw, values) {
  if (!raw) return undefined
  if (!values.includes(raw)) throw new HttpError(errors.badRequest, { reason: `status 只能是 ${values.join('|')}` })
  return raw
}

/** @type {import('../http/router.mjs').Handler} */
export async function list(ctx) {
  need(ctx, PERM.requirementView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const filters = {
    projectId: uuidFilter(ctx.url.searchParams.get('projectId')),
    status: enumFilter(ctx.url.searchParams.get('status'), svc.REQUIREMENT_STATUSES),
  }
  sendJson(ctx.res, 200, await svc.listRequirements(ctx, page, filters))
}

/** @type {import('../http/router.mjs').Handler} */
export async function get(ctx) {
  need(ctx, PERM.requirementView)
  sendJson(ctx.res, 200, await svc.getRequirement(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function create(ctx) {
  need(ctx, PERM.requirementCreate)
  const body = only(await readJson(ctx), CREATE_FIELDS)
  const input = validate(body, SPEC)
  sendJson(ctx.res, 201, await svc.createRequirement(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function update(ctx) {
  need(ctx, PERM.requirementUpdate)
  const body = only(await readJson(ctx), PATCH_FIELDS)
  const patch = validate(body, SPEC, { partial: true })
  sendJson(ctx.res, 200, await svc.updateRequirement(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function advance(ctx) {
  need(ctx, PERM.requirementUpdate)
  const body = only(await readJson(ctx), ADVANCE_FIELDS)
  const { to } = validate(body, ADVANCE_SPEC)
  sendJson(ctx.res, 200, await svc.advanceRequirement(ctx, ctx.params.id, String(to)))
}
