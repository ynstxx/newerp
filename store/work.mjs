import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 施工域租户表：所有语句必带 $t（跨表只读走 svc 里对其它域 store 的只读调用）

const PLAN_COLS = 'id, project_id, code, name, plan_start, plan_end, note, version, created_at, updated_at'
const TASK_COLS =
  'id, plan_id, project_id, code, title, assignee_id, status, progress, plan_start, plan_end, note, version, created_at, updated_at'
const PROGRESS_COLS = 'id, task_id, project_id, reporter_id, progress, content, at, created_at'
const ISSUE_COLS =
  'id, project_id, code, warehouse_id, applicant_id, amount, status, approval_instance_id, error_message, note, version, created_at, updated_at'
const ISSUE_LINE_COLS = 'id, issue_id, item_id, qty, unit_cost, note'
const CO_COLS =
  'id, project_id, code, title, amount, reason, status, approval_instance_id, applied_at, error_message, version, created_at, updated_at'
const ACC_COLS =
  'id, project_id, code, type, status, items, conclusion, accepted_by, accepted_at, version, created_at, updated_at'
const LABOR_COLS = 'id, project_id, task_id, user_id, work_date, hours, note, version, created_at, updated_at'
const SITE_COLS = 'id, project_id, author_id, recorded_at, weather, content, version, created_at, updated_at'

/**
 * 通用游标分页查询：条件由调用方构造，排序键固定 created_at + id（游标语义要求）。
 * @param {any} ctx
 * @param {string} table
 * @param {string} cols
 * @param {any} f
 * @param {string[]} conds
 * @param {unknown[]} args
 * @param {string} [cursorCol]
 */
function pageQuery(ctx, table, cols, f, conds, args, cursorCol = 'created_at') {
  const cur = cursorClause(f.cursor, args, f.order, cursorCol)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  const finalArgs = [...cur.args, f.limit + 1]
  const sql =
    `SELECT ${cols} FROM ${table} WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY ${cursorCol} ${f.order}, id ${f.order} LIMIT $${finalArgs.length}`
  return q(ctx, sql, finalArgs)
}

// ── work_plan ───────────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export const planById = (ctx, id) => one(ctx, `SELECT ${PLAN_COLS} FROM work_plan WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const planByCode = (ctx, code) => one(ctx, `SELECT ${PLAN_COLS} FROM work_plan WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, keyword?: string }} f
 */
export function planList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  const args = []
  if (f.projectId) {
    args.push(f.projectId)
    conds.push(`project_id = $${args.length}`)
  }
  if (f.keyword) {
    args.push(`%${f.keyword.toLowerCase()}%`)
    conds.push(`(LOWER(name) LIKE $${args.length} OR LOWER(code) LIKE $${args.length})`)
  }
  return pageQuery(ctx, 'work_plan', PLAN_COLS, f, conds, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, code: string, name: string, planStart: Date | null, planEnd: Date | null, note: string | null, now: Date }} p
 */
export const planInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO work_plan (tenant_id, id, project_id, code, name, plan_start, plan_end, note, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9)`,
    [ctx.tenantId, p.id, p.projectId, p.code, p.name, p.planStart, p.planEnd, p.note, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, name: string, planStart: Date | null, planEnd: Date | null, note: string | null, now: Date }} p
 */
export const planUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE work_plan
        SET name = $1, plan_start = $2, plan_end = $3, note = $4, version = version + 1, updated_at = $5
      WHERE $t AND id = $6 AND version = $7`,
    [p.name, p.planStart, p.planEnd, p.note, p.now, p.id, p.expectedVersion],
  )

// ── work_task ───────────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export const taskById = (ctx, id) => one(ctx, `SELECT ${TASK_COLS} FROM work_task WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const taskByCode = (ctx, code) => one(ctx, `SELECT ${TASK_COLS} FROM work_task WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, planId?: string, status?: string, assigneeId?: string, keyword?: string }} f
 */
export function taskList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  const args = []
  for (const [key, col] of [
    ['projectId', 'project_id'],
    ['planId', 'plan_id'],
    ['status', 'status'],
    ['assigneeId', 'assignee_id'],
  ]) {
    const v = /** @type {any} */ (f)[key]
    if (v) {
      args.push(v)
      conds.push(`${col} = $${args.length}`)
    }
  }
  if (f.keyword) {
    args.push(`%${f.keyword.toLowerCase()}%`)
    conds.push(`(LOWER(title) LIKE $${args.length} OR LOWER(code) LIKE $${args.length})`)
  }
  return pageQuery(ctx, 'work_task', TASK_COLS, f, conds, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, planId: string, projectId: string, code: string, title: string, assigneeId: string | null, planStart: Date | null, planEnd: Date | null, note: string | null, now: Date }} p
 */
export const taskInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO work_task
       (tenant_id, id, plan_id, project_id, code, title, assignee_id, status, progress,
        plan_start, plan_end, note, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'todo', 0, $8, $9, $10, 1, $11, $11)`,
    [ctx.tenantId, p.id, p.planId, p.projectId, p.code, p.title, p.assigneeId, p.planStart, p.planEnd, p.note, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, title: string, assigneeId: string | null, planStart: Date | null, planEnd: Date | null, note: string | null, now: Date }} p
 */
/** done 是终态：已完成的任务不能再改字段（0 行 → 上层转 409）
 * @param {any} ctx @param {any} p */
export const taskUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE work_task
        SET title = $1, assignee_id = $2, plan_start = $3, plan_end = $4, note = $5,
            version = version + 1, updated_at = $6
      WHERE $t AND id = $7 AND version = $8 AND status <> 'done'`,
    [p.title, p.assigneeId, p.planStart, p.planEnd, p.note, p.now, p.id, p.expectedVersion],
  )

/**
 * 状态与进度一起写：进度 100 与 done 必须同时成立，分两条 UPDATE 会出现中间态。
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, progress: number, expectedVersion: number, now: Date }} p
 */
export const taskSetStatus = (ctx, p) =>
  exec(
    ctx,
    `UPDATE work_task
        SET status = $1, progress = $2, version = version + 1, updated_at = $3
      WHERE $t AND id = $4 AND status = $5 AND version = $6`,
    [p.to, p.progress, p.now, p.id, p.from, p.expectedVersion],
  )

/**
 * 进度上报单独改 progress（不碰 status）—— 状态仍只走 advanceWorkTask。
 * @param {any} ctx
 * @param {{ id: string, progress: number, expectedVersion: number, now: Date }} p
 */
export const taskSetProgress = (ctx, p) =>
  exec(
    ctx,
    `UPDATE work_task SET progress = $1, version = version + 1, updated_at = $2
      WHERE $t AND id = $3 AND version = $4`,
    [p.progress, p.now, p.id, p.expectedVersion],
  )

// ── progress_log ────────────────────────────────────────────────────────────

/**
 * @param {any} ctx
 * @param {{ id: string, taskId: string, projectId: string, reporterId: string | null, progress: number, content: string | null, at: Date }} p
 */
export const progressInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO progress_log (tenant_id, id, task_id, project_id, reporter_id, progress, content, at, version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $8)`,
    [ctx.tenantId, p.id, p.taskId, p.projectId, p.reporterId, p.progress, p.content, p.at],
  )

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, taskId?: string, projectId?: string }} f
 */
export function progressList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  const args = []
  if (f.taskId) {
    args.push(f.taskId)
    conds.push(`task_id = $${args.length}`)
  }
  if (f.projectId) {
    args.push(f.projectId)
    conds.push(`project_id = $${args.length}`)
  }
  return pageQuery(ctx, 'progress_log', PROGRESS_COLS, f, conds, args, 'at')
}

/** @param {any} ctx @param {string} taskId */
export const progressOfTask = (ctx, taskId) =>
  q(ctx, `SELECT ${PROGRESS_COLS} FROM progress_log WHERE $t AND task_id = $1 ORDER BY at ASC, id ASC`, [taskId])

// ── material_issue ──────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export const issueById = (ctx, id) => one(ctx, `SELECT ${ISSUE_COLS} FROM material_issue WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const issueByCode = (ctx, code) =>
  one(ctx, `SELECT ${ISSUE_COLS} FROM material_issue WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, status?: string, warehouseId?: string }} f
 */
export function issueList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  const args = []
  for (const [key, col] of [
    ['projectId', 'project_id'],
    ['status', 'status'],
    ['warehouseId', 'warehouse_id'],
  ]) {
    const v = /** @type {any} */ (f)[key]
    if (v) {
      args.push(v)
      conds.push(`${col} = $${args.length}`)
    }
  }
  return pageQuery(ctx, 'material_issue', ISSUE_COLS, f, conds, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, code: string, warehouseId: string, applicantId: string | null, amount: string, note: string | null, now: Date }} p
 */
export const issueInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO material_issue
       (tenant_id, id, project_id, code, warehouse_id, applicant_id, amount, status, approval_instance_id,
        error_message, note, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', NULL, NULL, $8, 1, $9, $9)`,
    [ctx.tenantId, p.id, p.projectId, p.code, p.warehouseId, p.applicantId, p.amount, p.note, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, issueId: string, itemId: string, qty: string, unitCost: string | null, note: string | null }} p
 */
export const issueLineInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO material_issue_line (tenant_id, id, issue_id, item_id, qty, unit_cost, note, version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8)`,
    [ctx.tenantId, p.id, p.issueId, p.itemId, p.qty, p.unitCost, p.note, new Date()],
  )

/** @param {any} ctx @param {string} issueId */
export const issueLines = (ctx, issueId) =>
  q(ctx, `SELECT ${ISSUE_LINE_COLS} FROM material_issue_line WHERE $t AND issue_id = $1 ORDER BY created_at ASC, id ASC`, [
    issueId,
  ])

/** @param {any} ctx @param {string} issueId */
export const issueLinesClear = (ctx, issueId) =>
  exec(ctx, `DELETE FROM material_issue_line WHERE $t AND issue_id = $1`, [issueId])

/**
 * 草稿态可改：仓库/金额/备注。
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, warehouseId: string, amount: string, note: string | null, now: Date }} p
 */
export const issueUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE material_issue
        SET warehouse_id = $1, amount = $2, note = $3, version = version + 1, updated_at = $4
      WHERE $t AND id = $5 AND version = $6 AND status = 'draft'`,
    [p.warehouseId, p.amount, p.note, p.now, p.id, p.expectedVersion],
  )

/**
 * 状态迁移（draft→pending / pending→issued|rejected|failed）。
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, approvalInstanceId?: string | null, errorMessage?: string | null, now: Date }} p
 */
export const issueSetStatus = (ctx, p) =>
  exec(
    ctx,
    `UPDATE material_issue
        SET status = $1,
            approval_instance_id = COALESCE($2, approval_instance_id),
            error_message = $3,
            version = version + 1,
            updated_at = $4
      WHERE $t AND id = $5 AND status = $6`,
    [p.to, p.approvalInstanceId ?? null, p.errorMessage ?? null, p.now, p.id, p.from],
  )

// ── change_order ────────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export const coById = (ctx, id) => one(ctx, `SELECT ${CO_COLS} FROM change_order WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const coByCode = (ctx, code) => one(ctx, `SELECT ${CO_COLS} FROM change_order WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, status?: string }} f
 */
export function coList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  const args = []
  if (f.projectId) {
    args.push(f.projectId)
    conds.push(`project_id = $${args.length}`)
  }
  if (f.status) {
    args.push(f.status)
    conds.push(`status = $${args.length}`)
  }
  return pageQuery(ctx, 'change_order', CO_COLS, f, conds, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, code: string, title: string, amount: string, reason: string | null, now: Date }} p
 */
export const coInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO change_order
       (tenant_id, id, project_id, code, title, amount, reason, status, approval_instance_id, applied_at,
        error_message, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', NULL, NULL, NULL, 1, $8, $8)`,
    [ctx.tenantId, p.id, p.projectId, p.code, p.title, p.amount, p.reason, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, title: string, amount: string, reason: string | null, now: Date }} p
 */
export const coUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE change_order
        SET title = $1, amount = $2, reason = $3, version = version + 1, updated_at = $4
      WHERE $t AND id = $5 AND version = $6 AND status = 'draft'`,
    [p.title, p.amount, p.reason, p.now, p.id, p.expectedVersion],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, approvalInstanceId?: string | null, appliedAt?: Date | null, errorMessage?: string | null, now: Date }} p
 */
export const coSetStatus = (ctx, p) =>
  exec(
    ctx,
    `UPDATE change_order
        SET status = $1,
            approval_instance_id = COALESCE($2, approval_instance_id),
            applied_at = COALESCE($3, applied_at),
            error_message = $4,
            version = version + 1,
            updated_at = $5
      WHERE $t AND id = $6 AND status = $7`,
    [p.to, p.approvalInstanceId ?? null, p.appliedAt ?? null, p.errorMessage ?? null, p.now, p.id, p.from],
  )

/**
 * 变更签证落账：**这是本域唯一写 project 的 SQL**（store/project.mjs 属 M1，不去改它）。
 * version 条件兜住并发，0 行由 svc 转 409。
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, contractAmt: string, now: Date }} p
 */
export const projectAddContractAmt = (ctx, p) =>
  exec(
    ctx,
    `UPDATE project SET contract_amt = $1, version = version + 1, updated_at = $2
      WHERE $t AND id = $3 AND version = $4`,
    [p.contractAmt, p.now, p.id, p.expectedVersion],
  )

// ── acceptance ──────────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export const accById = (ctx, id) => one(ctx, `SELECT ${ACC_COLS} FROM acceptance WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const accByCode = (ctx, code) => one(ctx, `SELECT ${ACC_COLS} FROM acceptance WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, type?: string, status?: string }} f
 */
export function accList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  const args = []
  for (const [key, col] of [
    ['projectId', 'project_id'],
    ['type', 'type'],
    ['status', 'status'],
  ]) {
    const v = /** @type {any} */ (f)[key]
    if (v) {
      args.push(v)
      conds.push(`${col} = $${args.length}`)
    }
  }
  return pageQuery(ctx, 'acceptance', ACC_COLS, f, conds, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, code: string, type: string, items: unknown, conclusion: string | null, now: Date }} p
 */
export const accInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO acceptance
       (tenant_id, id, project_id, code, type, status, items, conclusion, accepted_by, accepted_at,
        version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, NULL, NULL, 1, $8, $8)`,
    [ctx.tenantId, p.id, p.projectId, p.code, p.type, JSON.stringify(p.items), p.conclusion, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, items: unknown, conclusion: string | null, now: Date }} p
 */
export const accUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE acceptance
        SET items = $1, conclusion = $2, version = version + 1, updated_at = $3
      WHERE $t AND id = $4 AND version = $5 AND status = 'draft'`,
    [JSON.stringify(p.items), p.conclusion, p.now, p.id, p.expectedVersion],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, acceptedBy: string | null, acceptedAt: Date, conclusion: string | null, now: Date }} p
 */
export const accConclude = (ctx, p) =>
  exec(
    ctx,
    `UPDATE acceptance
        SET status = $1, accepted_by = $2, accepted_at = $3, conclusion = $4,
            version = version + 1, updated_at = $5
      WHERE $t AND id = $6 AND status = $7`,
    [p.to, p.acceptedBy, p.acceptedAt, p.conclusion, p.now, p.id, p.from],
  )

// ── labor_hour ──────────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export const laborById = (ctx, id) => one(ctx, `SELECT ${LABOR_COLS} FROM labor_hour WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, userId?: string, taskId?: string, from?: string, to?: string }} f
 */
export function laborList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  const args = []
  for (const [key, col] of [
    ['projectId', 'project_id'],
    ['userId', 'user_id'],
    ['taskId', 'task_id'],
  ]) {
    const v = /** @type {any} */ (f)[key]
    if (v) {
      args.push(v)
      conds.push(`${col} = $${args.length}`)
    }
  }
  // 工时按工作日期过滤（前端一直传 from/to，之前服务端没认，只能本地过滤已加载页）
  if (f.from) {
    args.push(f.from)
    conds.push(`work_date >= $${args.length}`)
  }
  if (f.to) {
    args.push(f.to)
    conds.push(`work_date <= $${args.length}`)
  }
  return pageQuery(ctx, 'labor_hour', LABOR_COLS, f, conds, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, taskId: string | null, userId: string, workDate: Date, hours: string, note: string | null, now: Date }} p
 */
export const laborInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO labor_hour (tenant_id, id, project_id, task_id, user_id, work_date, hours, note, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $9)`,
    [ctx.tenantId, p.id, p.projectId, p.taskId, p.userId, p.workDate, p.hours, p.note, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, taskId: string | null, userId: string, workDate: Date, hours: string, note: string | null, now: Date }} p
 */
export const laborUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE labor_hour
        SET task_id = $1, user_id = $2, work_date = $3, hours = $4, note = $5,
            version = version + 1, updated_at = $6
      WHERE $t AND id = $7 AND version = $8`,
    [p.taskId, p.userId, p.workDate, p.hours, p.note, p.now, p.id, p.expectedVersion],
  )

/** @param {any} ctx @param {string} id */
export const laborDelete = (ctx, id) => exec(ctx, `DELETE FROM labor_hour WHERE $t AND id = $1`, [id])

// ── site_record ─────────────────────────────────────────────────────────────

/** @param {any} ctx @param {string} id */
export const siteById = (ctx, id) => one(ctx, `SELECT ${SITE_COLS} FROM site_record WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, keyword?: string }} f
 */
export function siteList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  const args = []
  if (f.projectId) {
    args.push(f.projectId)
    conds.push(`project_id = $${args.length}`)
  }
  if (f.keyword) {
    args.push(`%${f.keyword.toLowerCase()}%`)
    conds.push(`LOWER(content) LIKE $${args.length}`)
  }
  return pageQuery(ctx, 'site_record', SITE_COLS, f, conds, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, authorId: string | null, recordedAt: Date, weather: string | null, content: string, now: Date }} p
 */
export const siteInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO site_record (tenant_id, id, project_id, author_id, recorded_at, weather, content, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
    [ctx.tenantId, p.id, p.projectId, p.authorId, p.recordedAt, p.weather, p.content, p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, recordedAt: Date, weather: string | null, content: string, now: Date }} p
 */
export const siteUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE site_record
        SET recorded_at = $1, weather = $2, content = $3, version = version + 1, updated_at = $4
      WHERE $t AND id = $5 AND version = $6`,
    [p.recordedAt, p.weather, p.content, p.now, p.id, p.expectedVersion],
  )

/** @param {any} ctx @param {string} id */
export const siteDelete = (ctx, id) => exec(ctx, `DELETE FROM site_record WHERE $t AND id = $1`, [id])
