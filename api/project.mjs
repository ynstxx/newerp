import { need, PERM } from '../auth/perm.mjs'
import { readJson, only } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/project.mjs'

const FIELDS = ['name', 'pmUserId', 'startDate', 'endDate', 'note', 'version']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SPEC = {
  name: { type: 'string', max: 64 },
  pmUserId: { type: 'string', max: 36 },
  startDate: { type: 'string', max: 40 },
  endDate: { type: 'string', max: 40 },
  note: { type: 'string', max: 500 },
  version: { type: 'int' },
}

/** @type {import('../http/router.mjs').Handler} */
export async function list(ctx) {
  need(ctx, PERM.projectView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const status = ctx.url.searchParams.get('status') ?? undefined
  const keyword = (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined
  sendJson(ctx.res, 200, await svc.listProjects(ctx, page, { status, keyword }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function get(ctx) {
  need(ctx, PERM.projectView)
  sendJson(ctx.res, 200, await svc.getProject(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function stages(ctx) {
  need(ctx, PERM.projectView)
  sendJson(ctx.res, 200, await svc.listStages(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function update(ctx) {
  need(ctx, PERM.projectUpdate)
  const body = only(await readJson(ctx), FIELDS)
  const patch = validate(body, SPEC, { partial: true })
  sendJson(ctx.res, 200, await svc.updateProject(ctx, ctx.params.id, patch))
}

/**
 * terminated 是独立权限点（PERM.projectTerminate），member 没有 → 403。
 * @type {import('../http/router.mjs').Handler}
 */
export async function advance(ctx) {
  need(ctx, PERM.projectUpdate)
  const body = only(await readJson(ctx), ['to', 'note'])
  const input = validate(body, {
    to: { type: 'enum', values: svc.PROJECT_STATUSES, required: true },
    note: { type: 'string', max: 500 },
  })
  if (input.to === 'terminated') need(ctx, PERM.projectTerminate)
  sendJson(ctx.res, 200, await svc.advanceProject(ctx, ctx.params.id, /** @type {any} */ (input)))
}
