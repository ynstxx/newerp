import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { centsOf, moneyOf } from '../http/money.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import { nextCode, PREFIX } from './codegen.mjs'
import * as audit from '../store/audit.mjs'
import * as membership from '../store/membership.mjs'
import * as projectStore from '../store/project.mjs'
import * as store from '../store/work.mjs'
import { allowedNext, assertTransition } from './transition.mjs'

/**
 * 施工域基础实体：施工计划 / 任务 / 进度上报 / 工时 / 现场记录。
 * 领料、变更签证、验收在各自 svc（都带审批钩子或跨项目状态机）。
 */

export const TASK_TRANSITIONS = /** @type {const} */ ({
  todo: ['doing', 'done'],
  doing: ['done'],
  done: [],
})

export const TASK_STATUSES = Object.keys(TASK_TRANSITIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 */
export function assertId(/** @type {string} */ id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** @param {unknown} v @param {string} field */
export function dateOf(v, field) {
  if (v === undefined || v === null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new HttpError(errors.badRequest, { fields: { [field]: 'time' } })
  return d
}

/** @param {any} ctx @param {string} id 项目必须存在（跨租户 → 404） */
export async function mustProject(ctx, id) {
  const row = await projectStore.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return row
}

/** @param {string | null | undefined} v @param {string} field 可空 uuid */
function uuidOrNull(v, field) {
  if (v === undefined || v === null || v === '') return null
  if (!UUID.test(String(v))) throw new HttpError(errors.badRequest, { fields: { [field]: 'uuid' } })
  return String(v)
}

/** @param {any} r */
export const planToApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  code: r.code,
  name: r.name,
  planStart: r.plan_start,
  planEnd: r.plan_end,
  note: r.note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const taskToApi = (r) => ({
  id: r.id,
  planId: r.plan_id,
  projectId: r.project_id,
  code: r.code,
  title: r.title,
  assigneeId: r.assignee_id,
  status: r.status,
  progress: Number(r.progress),
  planStart: r.plan_start,
  planEnd: r.plan_end,
  note: r.note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(TASK_TRANSITIONS, r.status),
})

/** @param {any} r */
export const progressToApi = (r) => ({
  id: r.id,
  taskId: r.task_id,
  projectId: r.project_id,
  reporterId: r.reporter_id,
  progress: Number(r.progress),
  content: r.content,
  at: r.at,
})

/** @param {any} r */
export const laborToApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  taskId: r.task_id,
  userId: r.user_id,
  workDate: r.work_date,
  hours: Number(r.hours),
  note: r.note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const siteToApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  authorId: r.author_id,
  recordedAt: r.recorded_at,
  weather: r.weather,
  content: r.content,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

// ── 施工计划 ────────────────────────────────────────────────────────────────

/** @param {any} ctx @param {any} page @param {any} filters */
export async function listPlans(ctx, page, filters) {
  const rows = await store.planList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(planToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getPlan(ctx, id) {
  const row = await store.planById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const tasks = await store.taskList(ctx, {
    limit: 200,
    order: 'asc',
    cursor: null,
    planId: id,
  })
  return { ...planToApi(row), tasks: tasks.map(taskToApi) }
}

/** @param {any} ctx @param {{ projectId: string, code: string, name: string, planStart?: unknown, planEnd?: unknown, note?: string }} input */
export async function createPlan(ctx, input) {
  const project = await mustProject(ctx, input.projectId)
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.workPlan)
  if (await store.planByCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `计划编码 ${code} 已存在` })
  const now = new Date()
  const row = {
    id: randomUUID(),
    projectId: project.id,
    code,
    name: input.name,
    planStart: dateOf(input.planStart, 'planStart'),
    planEnd: dateOf(input.planEnd, 'planEnd'),
    note: input.note ?? null,
    now,
  }
  if (row.planStart && row.planEnd && row.planEnd < row.planStart) {
    throw new HttpError(errors.badRequest, { fields: { planEnd: 'after_start' } })
  }
  await withTx(ctx, async (tx) => {
    await store.planInsert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'plan_create',
      whoId: ctx.userId ?? null,
      refType: 'work_plan',
      refId: row.id,
      before: null,
      after: { code: row.code, projectId: row.projectId, name: row.name },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getPlan(ctx, row.id)
}

/** @param {any} ctx @param {string} id @param {Record<string, any>} patch */
export async function updatePlan(ctx, id, patch) {
  const cur = await store.planById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const planStart = 'planStart' in patch ? dateOf(patch.planStart, 'planStart') : cur.plan_start && new Date(cur.plan_start)
  const planEnd = 'planEnd' in patch ? dateOf(patch.planEnd, 'planEnd') : cur.plan_end && new Date(cur.plan_end)
  if (planStart && planEnd && planEnd < planStart) {
    throw new HttpError(errors.badRequest, { fields: { planEnd: 'after_start' } })
  }
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.planUpdate(tx, {
      id,
      expectedVersion: cur.version,
      name: patch.name ?? cur.name,
      planStart,
      planEnd,
      note: 'note' in patch ? patch.note : cur.note,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'plan_update',
      whoId: ctx.userId ?? null,
      refType: 'work_plan',
      refId: id,
      before: planToApi(cur),
      after: { name: patch.name ?? cur.name, planStart, planEnd, note: 'note' in patch ? patch.note : cur.note },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getPlan(ctx, id)
}

// ── 施工任务 ────────────────────────────────────────────────────────────────

/** @param {any} ctx @param {any} page @param {any} filters */
export async function listTasks(ctx, page, filters) {
  if (filters.projectId && !UUID.test(filters.projectId)) return { items: [], nextCursor: null }
  if (filters.planId && !UUID.test(filters.planId)) return { items: [], nextCursor: null }
  if (filters.assigneeId && !UUID.test(filters.assigneeId)) return { items: [], nextCursor: null }
  const rows = await store.taskList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(taskToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getTask(ctx, id) {
  const row = await store.taskById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const logs = await store.progressOfTask(ctx, id)
  return { ...taskToApi(row), progressLogs: logs.map(progressToApi) }
}

/** @param {any} ctx @param {{ planId: string, code: string, title: string, assigneeId?: string, planStart?: unknown, planEnd?: unknown, note?: string }} input */
export async function createTask(ctx, input) {
  const plan = await store.planById(ctx, assertId(input.planId))
  if (!plan) throw new HttpError(errors.notFound)
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.workTask)
  if (await store.taskByCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `任务编码 ${code} 已存在` })
  const assigneeId = uuidOrNull(input.assigneeId, 'assigneeId')
  if (assigneeId && !(await membership.memberExists(ctx, assigneeId))) {
    throw new HttpError(errors.badRequest, { fields: { assigneeId: 'not_member' } })
  }
  const row = {
    id: randomUUID(),
    planId: plan.id,
    projectId: plan.project_id,
    code,
    title: input.title,
    assigneeId,
    planStart: dateOf(input.planStart, 'planStart'),
    planEnd: dateOf(input.planEnd, 'planEnd'),
    note: input.note ?? null,
    now: new Date(),
  }
  if (row.planStart && row.planEnd && row.planEnd < row.planStart) {
    throw new HttpError(errors.badRequest, { fields: { planEnd: 'after_start' } })
  }
  await withTx(ctx, async (tx) => {
    await store.taskInsert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'task_create',
      whoId: ctx.userId ?? null,
      refType: 'work_task',
      refId: row.id,
      before: null,
      after: { code: row.code, planId: row.planId, projectId: row.projectId, title: row.title },
      traceId: ctx.requestId ?? '',
      at: row.now,
    })
  })
  return getTask(ctx, row.id)
}

/** @param {any} ctx @param {string} id @param {Record<string, any>} patch */
export async function updateTask(ctx, id, patch) {
  const cur = await store.taskById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const assigneeId = 'assigneeId' in patch ? uuidOrNull(patch.assigneeId, 'assigneeId') : cur.assignee_id
  if (assigneeId && assigneeId !== cur.assignee_id && !(await membership.memberExists(ctx, assigneeId))) {
    throw new HttpError(errors.badRequest, { fields: { assigneeId: 'not_member' } })
  }
  const planStart = 'planStart' in patch ? dateOf(patch.planStart, 'planStart') : cur.plan_start && new Date(cur.plan_start)
  const planEnd = 'planEnd' in patch ? dateOf(patch.planEnd, 'planEnd') : cur.plan_end && new Date(cur.plan_end)
  if (planStart && planEnd && planEnd < planStart) {
    throw new HttpError(errors.badRequest, { fields: { planEnd: 'after_start' } })
  }
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.taskUpdate(tx, {
      id,
      expectedVersion: cur.version,
      title: patch.title ?? cur.title,
      assigneeId,
      planStart,
      planEnd,
      note: 'note' in patch ? patch.note : cur.note,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'task_update',
      whoId: ctx.userId ?? null,
      refType: 'work_task',
      refId: id,
      before: taskToApi(cur),
      after: { title: patch.title ?? cur.title, assigneeId, planStart, planEnd },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getTask(ctx, id)
}

/**
 * 任务状态只能走状态机；done 强制 progress=100，避免出现「已完成但 30%」。
 * @param {any} ctx @param {string} id @param {{ to: string }} input
 */
export async function advanceTask(ctx, id, input) {
  const cur = await store.taskById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  assertTransition('work_task', TASK_TRANSITIONS, cur.status, input.to)
  const progress = input.to === 'done' ? 100 : Number(cur.progress)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.taskSetStatus(tx, {
      id,
      from: cur.status,
      to: input.to,
      progress,
      expectedVersion: cur.version,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '任务已被并发修改，请刷新' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'task_advance',
      whoId: ctx.userId ?? null,
      refType: 'work_task',
      refId: id,
      before: { status: cur.status, progress: Number(cur.progress) },
      after: { status: input.to, progress },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getTask(ctx, id)
}

// ── 进度上报 ────────────────────────────────────────────────────────────────

/** @param {any} ctx @param {any} page @param {any} filters */
export async function listProgressLogs(ctx, page, filters) {
  if (filters.taskId && !UUID.test(filters.taskId)) return { items: [], nextCursor: null }
  if (filters.projectId && !UUID.test(filters.projectId)) return { items: [], nextCursor: null }
  const rows = await store.progressList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(progressToApi), nextCursor }
}

/**
 * 进度上报：写 progress_log，同时把 task.progress 拉到最新（同一事务）。
 * @param {any} ctx @param {{ taskId: string, progress: number, content?: string }} input
 */
export async function reportProgress(ctx, input) {
  const task = await store.taskById(ctx, assertId(input.taskId))
  if (!task) throw new HttpError(errors.notFound)
  if (task.status === 'done') throw new HttpError(errors.conflict, { reason: '任务已完成，不能再上报进度', allowed: [] })
  const progress = Number(input.progress)
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw new HttpError(errors.badRequest, { fields: { progress: 'int:0..100' } })
  }
  const now = new Date()
  const log = {
    id: randomUUID(),
    taskId: task.id,
    projectId: task.project_id,
    reporterId: ctx.userId ?? null,
    progress,
    content: input.content ?? null,
    at: now,
  }
  await withTx(ctx, async (tx) => {
    await store.progressInsert(tx, log)
    const n = await store.taskSetProgress(tx, { id: task.id, progress, expectedVersion: task.version, now })
    if (!n) throw new HttpError(errors.conflict, { reason: '任务已被并发修改，请刷新' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'progress_report',
      whoId: ctx.userId ?? null,
      refType: 'work_task',
      refId: task.id,
      before: { progress: Number(task.progress) },
      after: { progress, content: log.content },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return { ...progressToApi(log) }
}

// ── 工时 ────────────────────────────────────────────────────────────────────

/** @param {any} ctx @param {any} page @param {any} filters */
export async function listLaborHours(ctx, page, filters) {
  for (const k of /** @type {const} */ (['projectId', 'userId', 'taskId'])) {
    if (filters[k] && !UUID.test(filters[k])) return { items: [], nextCursor: null }
  }
  const rows = await store.laborList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(laborToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getLaborHour(ctx, id) {
  const row = await store.laborById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return laborToApi(row)
}

/** @param {any} ctx @param {{ projectId: string, taskId?: string, userId?: string, workDate: string, hours: unknown, note?: string }} input */
export async function createLaborHour(ctx, input) {
  const project = await mustProject(ctx, input.projectId)
  const taskId = uuidOrNull(input.taskId, 'taskId')
  if (taskId) {
    const task = await store.taskById(ctx, taskId)
    if (!task || task.project_id !== project.id) throw new HttpError(errors.notFound)
  }
  const userId = uuidOrNull(input.userId, 'userId') ?? /** @type {string | null} */ (ctx.userId)
  if (!userId) throw new HttpError(errors.unauthorized)
  if (!(await membership.memberExists(ctx, userId))) {
    throw new HttpError(errors.badRequest, { fields: { userId: 'not_member' } })
  }
  const hoursCents = centsOf(input.hours, 'hours')
  if (hoursCents <= 0) throw new HttpError(errors.badRequest, { fields: { hours: 'positive' } })
  const workDate = dateOf(input.workDate, 'workDate')
  if (!workDate) throw new HttpError(errors.badRequest, { fields: { workDate: 'required' } })
  const now = new Date()
  const row = {
    id: randomUUID(),
    projectId: project.id,
    taskId,
    userId,
    workDate,
    hours: moneyOf(hoursCents),
    note: input.note ?? null,
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.laborInsert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'labor_create',
      whoId: ctx.userId ?? null,
      refType: 'labor_hour',
      refId: row.id,
      before: null,
      after: { projectId: row.projectId, userId, workDate, hours: row.hours },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getLaborHour(ctx, row.id)
}

/** @param {any} ctx @param {string} id @param {Record<string, any>} patch */
export async function updateLaborHour(ctx, id, patch) {
  const cur = await store.laborById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const taskId = 'taskId' in patch ? uuidOrNull(patch.taskId, 'taskId') : cur.task_id
  if (taskId) {
    const task = await store.taskById(ctx, taskId)
    if (!task || task.project_id !== cur.project_id) throw new HttpError(errors.notFound)
  }
  const userId = 'userId' in patch ? uuidOrNull(patch.userId, 'userId') : cur.user_id
  if (!userId) throw new HttpError(errors.badRequest, { fields: { userId: 'required' } })
  if (userId !== cur.user_id && !(await membership.memberExists(ctx, userId))) {
    throw new HttpError(errors.badRequest, { fields: { userId: 'not_member' } })
  }
  const hoursCents = 'hours' in patch ? centsOf(patch.hours, 'hours') : centsOf(cur.hours, 'hours')
  if (hoursCents <= 0) throw new HttpError(errors.badRequest, { fields: { hours: 'positive' } })
  const workDate = 'workDate' in patch ? dateOf(patch.workDate, 'workDate') : new Date(cur.work_date)
  if (!workDate) throw new HttpError(errors.badRequest, { fields: { workDate: 'required' } })
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.laborUpdate(tx, {
      id,
      expectedVersion: cur.version,
      taskId,
      userId,
      workDate,
      hours: moneyOf(hoursCents),
      note: 'note' in patch ? patch.note : cur.note,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'labor_update',
      whoId: ctx.userId ?? null,
      refType: 'labor_hour',
      refId: id,
      before: laborToApi(cur),
      after: { taskId, userId, workDate, hours: moneyOf(hoursCents) },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getLaborHour(ctx, id)
}

/** @param {any} ctx @param {string} id */
export async function deleteLaborHour(ctx, id) {
  const cur = await store.laborById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    await store.laborDelete(tx, id)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'labor_delete',
      whoId: ctx.userId ?? null,
      refType: 'labor_hour',
      refId: id,
      before: laborToApi(cur),
      after: null,
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return { ok: true }
}

// ── 现场记录 ────────────────────────────────────────────────────────────────

/** @param {any} ctx @param {any} page @param {any} filters */
export async function listSiteRecords(ctx, page, filters) {
  if (filters.projectId && !UUID.test(filters.projectId)) return { items: [], nextCursor: null }
  const rows = await store.siteList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(siteToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getSiteRecord(ctx, id) {
  const row = await store.siteById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return siteToApi(row)
}

/** @param {any} ctx @param {{ projectId: string, recordedAt?: string, weather?: string, content: string }} input */
export async function createSiteRecord(ctx, input) {
  const project = await mustProject(ctx, input.projectId)
  const now = new Date()
  const row = {
    id: randomUUID(),
    projectId: project.id,
    authorId: ctx.userId ?? null,
    recordedAt: dateOf(input.recordedAt, 'recordedAt') ?? now,
    weather: input.weather ?? null,
    content: input.content,
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.siteInsert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'site_create',
      whoId: ctx.userId ?? null,
      refType: 'site_record',
      refId: row.id,
      before: null,
      after: { projectId: row.projectId, recordedAt: row.recordedAt, weather: row.weather },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getSiteRecord(ctx, row.id)
}

/** @param {any} ctx @param {string} id @param {Record<string, any>} patch */
export async function updateSiteRecord(ctx, id, patch) {
  const cur = await store.siteById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const recordedAt = 'recordedAt' in patch ? dateOf(patch.recordedAt, 'recordedAt') : new Date(cur.recorded_at)
  if (!recordedAt) throw new HttpError(errors.badRequest, { fields: { recordedAt: 'required' } })
  const content = patch.content ?? cur.content
  if (!content) throw new HttpError(errors.badRequest, { fields: { content: 'required' } })
  const weather = 'weather' in patch ? patch.weather : cur.weather
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.siteUpdate(tx, {
      id,
      expectedVersion: cur.version,
      recordedAt,
      weather,
      content,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'site_update',
      whoId: ctx.userId ?? null,
      refType: 'site_record',
      refId: id,
      before: siteToApi(cur),
      after: { recordedAt, weather, content },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getSiteRecord(ctx, id)
}

/** @param {any} ctx @param {string} id */
export async function deleteSiteRecord(ctx, id) {
  const cur = await store.siteById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    await store.siteDelete(tx, id)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'work',
      action: 'site_delete',
      whoId: ctx.userId ?? null,
      refType: 'site_record',
      refId: id,
      before: siteToApi(cur),
      after: null,
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return { ok: true }
}
