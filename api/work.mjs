import { need } from '../auth/perm.mjs'
import { only, readJson } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as acceptance from '../svc/acceptance.mjs'
import * as changeOrder from '../svc/change_order.mjs'
import * as materialIssue from '../svc/material_issue.mjs'
import * as work from '../svc/work.mjs'

/**
 * 施工域 API（M3）：计划/任务/进度/领料/变更签证/验收/工时/现场记录。
 * 权限串直接写字符串（DESIGN §8），不改 auth/perm.mjs：member 有 *:view|create|update，delete 只有 owner。
 */

const VIEW = 'work:view'
const CREATE = 'work:create'
const UPDATE = 'work:update'
const DELETE = 'work:delete'

const PLAN_FIELDS = ['projectId', 'code', 'name', 'planStart', 'planEnd', 'note']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PLAN_SPEC = {
  projectId: { type: 'string', required: true, max: 36 },
  code: { type: 'code', required: true, max: 64 },
  name: { type: 'string', required: true, max: 64 },
  planStart: { type: 'string', max: 40 },
  planEnd: { type: 'string', max: 40 },
  note: { type: 'string', max: 500 },
}
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PLAN_PATCH_SPEC = {
  name: { type: 'string', max: 64 },
  planStart: { type: 'string', max: 40 },
  planEnd: { type: 'string', max: 40 },
  note: { type: 'string', max: 500 },
  version: { type: 'int' },
}

const TASK_FIELDS = ['planId', 'code', 'title', 'assigneeId', 'planStart', 'planEnd', 'note']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const TASK_SPEC = {
  planId: { type: 'string', required: true, max: 36 },
  code: { type: 'code', required: true, max: 64 },
  title: { type: 'string', required: true, max: 64 },
  assigneeId: { type: 'string', max: 36 },
  planStart: { type: 'string', max: 40 },
  planEnd: { type: 'string', max: 40 },
  note: { type: 'string', max: 500 },
}
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const TASK_PATCH_SPEC = {
  title: { type: 'string', max: 64 },
  assigneeId: { type: 'string', max: 36 },
  planStart: { type: 'string', max: 40 },
  planEnd: { type: 'string', max: 40 },
  note: { type: 'string', max: 500 },
  version: { type: 'int' },
}

const PROGRESS_FIELDS = ['taskId', 'progress', 'content']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PROGRESS_SPEC = {
  taskId: { type: 'string', required: true, max: 36 },
  progress: { type: 'int', required: true },
  content: { type: 'string', max: 500 },
}

const ISSUE_FIELDS = ['projectId', 'code', 'warehouseId', 'amount', 'note', 'lines']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const ISSUE_SPEC = {
  projectId: { type: 'string', required: true, max: 36 },
  code: { type: 'code', required: true, max: 64 },
  warehouseId: { type: 'string', required: true, max: 36 },
  note: { type: 'string', max: 500 },
}
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const ISSUE_PATCH_SPEC = {
  warehouseId: { type: 'string', max: 36 },
  note: { type: 'string', max: 500 },
  version: { type: 'int' },
}

const CO_FIELDS = ['projectId', 'code', 'title', 'amount', 'reason']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const CO_SPEC = {
  projectId: { type: 'string', required: true, max: 36 },
  code: { type: 'code', required: true, max: 64 },
  title: { type: 'string', required: true, max: 64 },
  reason: { type: 'string', max: 500 },
}
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const CO_PATCH_SPEC = {
  title: { type: 'string', max: 64 },
  reason: { type: 'string', max: 500 },
  version: { type: 'int' },
}

const ACC_FIELDS = ['projectId', 'code', 'type', 'items', 'conclusion']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const ACC_SPEC = {
  projectId: { type: 'string', required: true, max: 36 },
  code: { type: 'code', required: true, max: 64 },
  type: { type: 'enum', values: [...acceptance.ACCEPTANCE_TYPES], required: true },
  conclusion: { type: 'string', max: 500 },
}
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const ACC_PATCH_SPEC = {
  conclusion: { type: 'string', max: 500 },
  version: { type: 'int' },
}

const LABOR_FIELDS = ['projectId', 'taskId', 'userId', 'workDate', 'hours', 'note']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const LABOR_SPEC = {
  projectId: { type: 'string', required: true, max: 36 },
  taskId: { type: 'string', max: 36 },
  userId: { type: 'string', max: 36 },
  workDate: { type: 'string', required: true, max: 40 },
  note: { type: 'string', max: 500 },
}
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const LABOR_PATCH_SPEC = {
  taskId: { type: 'string', max: 36 },
  userId: { type: 'string', max: 36 },
  workDate: { type: 'string', max: 40 },
  note: { type: 'string', max: 500 },
  version: { type: 'int' },
}

const SITE_FIELDS = ['projectId', 'recordedAt', 'weather', 'content']
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SITE_SPEC = {
  projectId: { type: 'string', required: true, max: 36 },
  recordedAt: { type: 'string', max: 40 },
  weather: { type: 'code', max: 64 },
  content: { type: 'string', required: true, max: 2000 },
}
/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SITE_PATCH_SPEC = {
  recordedAt: { type: 'string', max: 40 },
  weather: { type: 'code', max: 64 },
  content: { type: 'string', max: 2000 },
  version: { type: 'int' },
}

/** @param {any} v */
const str = (v) => (v === undefined || v === null || v === '' ? undefined : String(v))
/** @param {any} ctx */
const keywordOf = (ctx) => (ctx.url.searchParams.get('q') ?? '').trim().slice(0, 64) || undefined
/** @param {any} ctx @param {string} name */
const qp = (ctx, name) => str(ctx.url.searchParams.get(name))
/** @param {any} ctx */
const pageOf = (ctx) => parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })

// ── work plans ──────────────────────────────────────────────────────────────

/** @type {import('../http/router.mjs').Handler} */
export async function listPlans(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await work.listPlans(ctx, pageOf(ctx), { projectId: qp(ctx, 'projectId'), keyword: keywordOf(ctx) }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function getPlan(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await work.getPlan(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createPlan(ctx) {
  need(ctx, CREATE)
  const body = only(await readJson(ctx), PLAN_FIELDS)
  const input = validate(body, PLAN_SPEC)
  sendJson(ctx.res, 201, await work.createPlan(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updatePlan(ctx) {
  need(ctx, UPDATE)
  const body = only(await readJson(ctx), Object.keys(PLAN_PATCH_SPEC))
  const patch = validate(body, PLAN_PATCH_SPEC, { partial: true })
  sendJson(ctx.res, 200, await work.updatePlan(ctx, ctx.params.id, patch))
}

// ── work tasks ──────────────────────────────────────────────────────────────

/** @type {import('../http/router.mjs').Handler} */
export async function listTasks(ctx) {
  need(ctx, VIEW)
  sendJson(
    ctx.res,
    200,
    await work.listTasks(ctx, pageOf(ctx), {
      projectId: qp(ctx, 'projectId'),
      planId: qp(ctx, 'planId'),
      status: qp(ctx, 'status'),
      assigneeId: qp(ctx, 'assigneeId'),
      keyword: keywordOf(ctx),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getTask(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await work.getTask(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createTask(ctx) {
  need(ctx, CREATE)
  const body = only(await readJson(ctx), TASK_FIELDS)
  const input = validate(body, TASK_SPEC)
  sendJson(ctx.res, 201, await work.createTask(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateTask(ctx) {
  need(ctx, UPDATE)
  const body = only(await readJson(ctx), Object.keys(TASK_PATCH_SPEC))
  const patch = validate(body, TASK_PATCH_SPEC, { partial: true })
  sendJson(ctx.res, 200, await work.updateTask(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function advanceTask(ctx) {
  need(ctx, UPDATE)
  const body = only(await readJson(ctx), ['to'])
  const input = validate(body, { to: { type: 'enum', values: work.TASK_STATUSES, required: true } })
  sendJson(ctx.res, 200, await work.advanceTask(ctx, ctx.params.id, /** @type {any} */ (input)))
}

// ── progress logs ───────────────────────────────────────────────────────────

/** @type {import('../http/router.mjs').Handler} */
export async function listProgressLogs(ctx) {
  need(ctx, VIEW)
  sendJson(
    ctx.res,
    200,
    await work.listProgressLogs(ctx, pageOf(ctx), { taskId: qp(ctx, 'taskId'), projectId: qp(ctx, 'projectId') }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function createProgressLog(ctx) {
  need(ctx, CREATE)
  const body = only(await readJson(ctx), PROGRESS_FIELDS)
  const input = validate(body, PROGRESS_SPEC)
  sendJson(ctx.res, 201, await work.reportProgress(ctx, /** @type {any} */ (input)))
}

// ── material issues ─────────────────────────────────────────────────────────

/** @type {import('../http/router.mjs').Handler} */
export async function listMaterialIssues(ctx) {
  need(ctx, VIEW)
  sendJson(
    ctx.res,
    200,
    await materialIssue.listMaterialIssues(ctx, pageOf(ctx), {
      projectId: qp(ctx, 'projectId'),
      warehouseId: qp(ctx, 'warehouseId'),
      status: qp(ctx, 'status'),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getMaterialIssue(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await materialIssue.getMaterialIssue(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createMaterialIssue(ctx) {
  need(ctx, CREATE)
  const body = only(await readJson(ctx), ISSUE_FIELDS)
  const input = validate(body, ISSUE_SPEC)
  sendJson(
    ctx.res,
    201,
    await materialIssue.createMaterialIssue(ctx, {
      .../** @type {any} */ (input),
      amount: body.amount,
      lines: body.lines,
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateMaterialIssue(ctx) {
  need(ctx, UPDATE)
  const body = only(await readJson(ctx), [...Object.keys(ISSUE_PATCH_SPEC), 'amount', 'lines'])
  const patch = validate(body, ISSUE_PATCH_SPEC, { partial: true })
  if ('amount' in body) patch.amount = body.amount
  if ('lines' in body) patch.lines = body.lines
  sendJson(ctx.res, 200, await materialIssue.updateMaterialIssue(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function submitMaterialIssue(ctx) {
  need(ctx, UPDATE)
  sendJson(ctx.res, 200, await materialIssue.submitMaterialIssue(ctx, ctx.params.id))
}

// ── change orders ───────────────────────────────────────────────────────────

/** @type {import('../http/router.mjs').Handler} */
export async function listChangeOrders(ctx) {
  need(ctx, VIEW)
  sendJson(
    ctx.res,
    200,
    await changeOrder.listChangeOrders(ctx, pageOf(ctx), {
      projectId: qp(ctx, 'projectId'),
      status: qp(ctx, 'status'),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getChangeOrder(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await changeOrder.getChangeOrder(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createChangeOrder(ctx) {
  need(ctx, CREATE)
  const body = only(await readJson(ctx), CO_FIELDS)
  const input = validate(body, CO_SPEC)
  sendJson(ctx.res, 201, await changeOrder.createChangeOrder(ctx, { .../** @type {any} */ (input), amount: body.amount }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateChangeOrder(ctx) {
  need(ctx, UPDATE)
  const body = only(await readJson(ctx), [...Object.keys(CO_PATCH_SPEC), 'amount'])
  const patch = validate(body, CO_PATCH_SPEC, { partial: true })
  if ('amount' in body) patch.amount = body.amount
  sendJson(ctx.res, 200, await changeOrder.updateChangeOrder(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function submitChangeOrder(ctx) {
  need(ctx, UPDATE)
  sendJson(ctx.res, 200, await changeOrder.submitChangeOrder(ctx, ctx.params.id))
}

// ── acceptances ─────────────────────────────────────────────────────────────

/** @type {import('../http/router.mjs').Handler} */
export async function listAcceptances(ctx) {
  need(ctx, VIEW)
  sendJson(
    ctx.res,
    200,
    await acceptance.listAcceptances(ctx, pageOf(ctx), {
      projectId: qp(ctx, 'projectId'),
      type: qp(ctx, 'type'),
      status: qp(ctx, 'status'),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getAcceptance(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await acceptance.getAcceptance(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createAcceptance(ctx) {
  need(ctx, CREATE)
  const body = only(await readJson(ctx), ACC_FIELDS)
  const input = validate(body, ACC_SPEC)
  sendJson(ctx.res, 201, await acceptance.createAcceptance(ctx, { .../** @type {any} */ (input), items: body.items }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateAcceptance(ctx) {
  need(ctx, UPDATE)
  const body = only(await readJson(ctx), [...Object.keys(ACC_PATCH_SPEC), 'items'])
  const patch = validate(body, ACC_PATCH_SPEC, { partial: true })
  if ('items' in body) patch.items = body.items
  sendJson(ctx.res, 200, await acceptance.updateAcceptance(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function concludeAcceptance(ctx) {
  need(ctx, UPDATE)
  const body = only(await readJson(ctx), ['to', 'conclusion'])
  const input = validate(body, {
    to: { type: 'enum', values: ['passed', 'failed'], required: true },
    conclusion: { type: 'string', max: 500 },
  })
  sendJson(ctx.res, 200, await acceptance.concludeAcceptance(ctx, ctx.params.id, /** @type {any} */ (input)))
}

// ── labor hours ─────────────────────────────────────────────────────────────

/** @type {import('../http/router.mjs').Handler} */
export async function listLaborHours(ctx) {
  need(ctx, VIEW)
  sendJson(
    ctx.res,
    200,
    await work.listLaborHours(ctx, pageOf(ctx), {
      projectId: qp(ctx, 'projectId'),
      userId: qp(ctx, 'userId'),
      taskId: qp(ctx, 'taskId'),
      from: qp(ctx, 'from'),
      to: qp(ctx, 'to'),
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getLaborHour(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await work.getLaborHour(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createLaborHour(ctx) {
  need(ctx, CREATE)
  const body = only(await readJson(ctx), LABOR_FIELDS)
  const input = validate(body, LABOR_SPEC)
  sendJson(ctx.res, 201, await work.createLaborHour(ctx, { .../** @type {any} */ (input), hours: body.hours }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateLaborHour(ctx) {
  need(ctx, UPDATE)
  const body = only(await readJson(ctx), [...Object.keys(LABOR_PATCH_SPEC), 'hours'])
  const patch = validate(body, LABOR_PATCH_SPEC, { partial: true })
  if ('hours' in body) patch.hours = body.hours
  sendJson(ctx.res, 200, await work.updateLaborHour(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function deleteLaborHour(ctx) {
  need(ctx, DELETE)
  sendJson(ctx.res, 200, await work.deleteLaborHour(ctx, ctx.params.id))
}

// ── site records ────────────────────────────────────────────────────────────

/** @type {import('../http/router.mjs').Handler} */
export async function listSiteRecords(ctx) {
  need(ctx, VIEW)
  sendJson(
    ctx.res,
    200,
    await work.listSiteRecords(ctx, pageOf(ctx), { projectId: qp(ctx, 'projectId'), keyword: keywordOf(ctx) }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function getSiteRecord(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await work.getSiteRecord(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createSiteRecord(ctx) {
  need(ctx, CREATE)
  const body = only(await readJson(ctx), SITE_FIELDS)
  const input = validate(body, SITE_SPEC)
  sendJson(ctx.res, 201, await work.createSiteRecord(ctx, /** @type {any} */ (input)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateSiteRecord(ctx) {
  need(ctx, UPDATE)
  const body = only(await readJson(ctx), Object.keys(SITE_PATCH_SPEC))
  const patch = validate(body, SITE_PATCH_SPEC, { partial: true })
  sendJson(ctx.res, 200, await work.updateSiteRecord(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function deleteSiteRecord(ctx) {
  need(ctx, DELETE)
  sendJson(ctx.res, 200, await work.deleteSiteRecord(ctx, ctx.params.id))
}
