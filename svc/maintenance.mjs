import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import * as audit from '../store/audit.mjs'
import * as membership from '../store/membership.mjs'
import * as store from '../store/maintenance.mjs'
import { contractById } from '../store/ticket.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {string} id */
function assertId(id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** @param {any} r */
export const planToApi = (r) => ({
  id: r.id,
  contractId: r.contract_id,
  name: r.name,
  cronNote: r.cron_note,
  nextAt: r.next_at,
  enabled: Boolean(r.enabled),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const taskToApi = (r) => ({
  id: r.id,
  planId: r.plan_id,
  dueAt: r.due_at,
  doneAt: r.done_at,
  result: r.result,
  assigneeId: r.assignee_id,
})

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ contractId?: string, enabled?: boolean, keyword?: string }} filters
 */
export async function listPlans(ctx, page, filters) {
  const rows = await store.list(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(planToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getPlan(ctx, id) {
  const row = await store.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const tasks = await store.tasksOf(ctx, id)
  return { ...planToApi(row), tasks: tasks.map(taskToApi) }
}

/**
 * @param {any} ctx
 * @param {{ contractId: string, name: string, cronNote?: string | null, nextAt?: Date | null, enabled?: boolean }} input
 */
export async function createPlan(ctx, input) {
  const contractId = assertId(input.contractId)
  if (!(await contractById(ctx, contractId))) throw new HttpError(errors.notFound)
  const now = new Date()
  const id = randomUUID()
  const row = {
    id,
    contractId,
    name: input.name,
    cronNote: input.cronNote ?? null,
    nextAt: input.nextAt ?? null,
    enabled: input.enabled ?? true,
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.insert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'maintenance:create',
      whoId: ctx.userId ?? null,
      refType: 'maintenance_plan',
      refId: id,
      before: null,
      after: { contractId, name: row.name, nextAt: row.nextAt, enabled: row.enabled },
      traceId: tx.requestId ?? '',
      at: now,
    })
  })
  return getPlan(ctx, id)
}

/**
 * @param {any} ctx
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updatePlan(ctx, id, patch) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  const contractId = patch.contractId !== undefined ? assertId(patch.contractId) : cur.contract_id
  if (contractId !== cur.contract_id && !(await contractById(ctx, contractId))) throw new HttpError(errors.notFound)
  const now = new Date()
  const row = {
    id,
    contractId,
    name: patch.name ?? cur.name,
    cronNote: 'cronNote' in patch ? patch.cronNote : cur.cron_note,
    nextAt: 'nextAt' in patch ? patch.nextAt : cur.next_at,
    enabled: patch.enabled !== undefined ? patch.enabled : Boolean(cur.enabled),
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.update(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'maintenance:update',
      whoId: ctx.userId ?? null,
      refType: 'maintenance_plan',
      refId: id,
      before: planToApi(cur),
      after: { ...row, now: undefined },
      traceId: tx.requestId ?? '',
      at: now,
    })
  })
  return getPlan(ctx, id)
}

/** @param {any} ctx @param {string} planId */
export async function listTasks(ctx, planId) {
  const row = await store.byId(ctx, assertId(planId))
  if (!row) throw new HttpError(errors.notFound)
  const tasks = await store.tasksOf(ctx, planId)
  return { items: tasks.map(taskToApi) }
}

/**
 * @param {any} ctx
 * @param {string} planId
 * @param {{ dueAt: Date, assigneeId?: string | null }} input
 */
export async function createTask(ctx, planId, input) {
  const plan = await store.byId(ctx, assertId(planId))
  if (!plan) throw new HttpError(errors.notFound)
  const assigneeId = input.assigneeId ? assertId(input.assigneeId) : null
  if (assigneeId && !(await membership.memberExists(ctx, assigneeId))) {
    throw new HttpError(errors.badRequest, { fields: { assigneeId: 'not_member' } })
  }
  const now = new Date()
  const id = randomUUID()
  await withTx(ctx, async (tx) => {
    await store.insertTask(tx, { id, planId, dueAt: input.dueAt, assigneeId })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'maintenance_task:create',
      whoId: ctx.userId ?? null,
      refType: 'maintenance_task',
      refId: id,
      before: null,
      after: { planId, dueAt: input.dueAt, assigneeId },
      traceId: tx.requestId ?? '',
      at: now,
    })
  })
  const row = await store.taskById(ctx, id)
  return taskToApi(row)
}

/**
 * @param {any} ctx
 * @param {string} id
 * @param {{ result?: string | null }} input
 */
export async function finishTask(ctx, id, input) {
  const cur = await store.taskById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.finishTask(tx, { id, result: input.result ?? null, now })
    if (!n) throw new HttpError(errors.conflict, { reason: '巡检任务已完成，请勿重复提交' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'maintenance_task:done',
      whoId: ctx.userId ?? null,
      refType: 'maintenance_task',
      refId: id,
      before: { doneAt: cur.done_at },
      after: { doneAt: now, result: input.result ?? null },
      traceId: tx.requestId ?? '',
      at: now,
    })
  })
  return taskToApi(await store.taskById(ctx, id))
}
