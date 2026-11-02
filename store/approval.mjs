import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 租户表：所有语句必带 $t（跨表只读用子查询 + 手动 tenant 对齐，避免 $t 展开后列名歧义）

const FLOW_COLS = 'id, code, name, doc_type, enabled, steps, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const flowById = (ctx, id) => one(ctx, `SELECT ${FLOW_COLS} FROM approval_flow WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const flowByCode = (ctx, code) => one(ctx, `SELECT ${FLOW_COLS} FROM approval_flow WHERE $t AND code = $1`, [code])

/** @param {any} ctx @param {string} docType */
export const flowsByDocType = (ctx, docType) =>
  q(ctx, `SELECT ${FLOW_COLS} FROM approval_flow WHERE $t AND doc_type = $1 AND enabled = true ORDER BY code ASC`, [
    docType,
  ])

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, docType?: string, enabled?: boolean }} f
 */
export function flowList(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []
  if (f.docType) {
    args.push(f.docType)
    conds.push(`doc_type = $${args.length}`)
  }
  if (f.enabled !== undefined) {
    args.push(f.enabled)
    conds.push(`enabled = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args
  args.push(f.limit + 1)
  const sql =
    `SELECT ${FLOW_COLS} FROM approval_flow WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, code: string, name: string, docType: string, enabled: boolean, steps: unknown, now: Date }} p
 */
export const flowInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO approval_flow (tenant_id, id, code, name, doc_type, enabled, steps, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
    [ctx.tenantId, p.id, p.code, p.name, p.docType, p.enabled, JSON.stringify(p.steps), p.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, name: string, docType: string, enabled: boolean, steps: unknown, now: Date }} p
 */
export const flowUpdate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE approval_flow
        SET name = $1, doc_type = $2, enabled = $3, steps = $4, updated_at = $5, version = version + 1
      WHERE $t AND id = $6 AND version = $7`,
    [p.name, p.docType, p.enabled, JSON.stringify(p.steps), p.now, p.id, p.expectedVersion],
  )

const INSTANCE_COLS =
  'id, flow_id, doc_type, doc_id, status, current_step, amount, flow_snapshot, submitter_id, submitted_at, finished_at, version, created_at, updated_at'

/** @param {any} ctx @param {string} id */
export const instanceById = (ctx, id) =>
  one(ctx, `SELECT ${INSTANCE_COLS} FROM approval_instance WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} docType @param {string} docId */
export const pendingInstanceByDoc = (ctx, docType, docId) =>
  one(
    ctx,
    `SELECT ${INSTANCE_COLS} FROM approval_instance WHERE $t AND doc_type = $1 AND doc_id = $2 AND status = 'pending'`,
    [docType, docId],
  )

/**
 * 待处理实例（myTasks 的 role 型补充匹配要读快照整列，不能走 JSON 路径查询）
 * @param {any} ctx
 */
export const pendingInstances = (ctx) =>
  q(ctx, `SELECT ${INSTANCE_COLS} FROM approval_instance WHERE $t AND status = 'pending' ORDER BY submitted_at ASC`, [])

/**
 * @param {any} ctx
 * @param {{ id: string, flowId: string, docType: string, docId: string, status: string, currentStep: number, amount: string, flowSnapshot: unknown, submitterId: string, now: Date }} p
 */
export const instanceInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO approval_instance
       (tenant_id, id, flow_id, doc_type, doc_id, status, current_step, amount, flow_snapshot,
        submitter_id, submitted_at, finished_at, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, 1, $11, $11)`,
    [
      ctx.tenantId,
      p.id,
      p.flowId,
      p.docType,
      p.docId,
      p.status,
      p.currentStep,
      p.amount,
      JSON.stringify(p.flowSnapshot),
      p.submitterId,
      p.now,
    ],
  )

/**
 * 状态落定（approved / rejected / withdrawn），带版本号与 from 双重守卫。
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, expectedVersion: number, now: Date }} p
 */
export const instanceFinish = (ctx, p) =>
  exec(
    ctx,
    `UPDATE approval_instance
        SET status = $1, finished_at = $2, updated_at = $2, version = version + 1
      WHERE $t AND id = $3 AND status = $4 AND version = $5`,
    [p.to, p.now, p.id, p.from, p.expectedVersion],
  )

/**
 * 推进到下一级
 * @param {any} ctx
 * @param {{ id: string, from: string, step: number, expectedVersion: number, now: Date }} p
 */
export const instanceAdvance = (ctx, p) =>
  exec(
    ctx,
    `UPDATE approval_instance
        SET current_step = $1, updated_at = $2, version = version + 1
      WHERE $t AND id = $3 AND status = $4 AND version = $5`,
    [p.step, p.now, p.id, p.from, p.expectedVersion],
  )

const TASK_COLS =
  'id, instance_id, step_no, approver_user_id, status, acted_at, comment, remind_count, version, created_at'

/** @param {any} ctx @param {string} id */
export const taskById = (ctx, id) => one(ctx, `SELECT ${TASK_COLS} FROM approval_task WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} instanceId @param {number} stepNo */
export const tasksByStep = (ctx, instanceId, stepNo) =>
  q(
    ctx,
    `SELECT ${TASK_COLS} FROM approval_task WHERE $t AND instance_id = $1 AND step_no = $2 ORDER BY created_at ASC, id ASC`,
    [instanceId, stepNo],
  )

/** @param {any} ctx @param {string} instanceId */
export const pendingTasksByInstance = (ctx, instanceId) =>
  q(
    ctx,
    `SELECT ${TASK_COLS} FROM approval_task WHERE $t AND instance_id = $1 AND status = 'pending' ORDER BY step_no ASC, id ASC`,
    [instanceId],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, instanceId: string, stepNo: number, approverUserId: string | null, now: Date }} p
 */
export const taskInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO approval_task
       (tenant_id, id, instance_id, step_no, approver_user_id, status, acted_at, comment, remind_count, version, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', NULL, NULL, 0, 1, $6)`,
    [ctx.tenantId, p.id, p.instanceId, p.stepNo, p.approverUserId, p.now],
  )

/**
 * 审批一个任务（同时可认领 role 占位行）。0 行 = 已被别人处理/版本冲突 → 409。
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, status: string, comment: string | null, claimUserId: string | null, now: Date }} p
 */
export const taskDecide = (ctx, p) =>
  exec(
    ctx,
    `UPDATE approval_task
        SET status = $1, acted_at = $2, comment = $3, approver_user_id = COALESCE($4, approver_user_id),
            version = version + 1
      WHERE $t AND id = $5 AND status = 'pending' AND version = $6`,
    [p.status, p.now, p.comment, p.claimUserId, p.id, p.expectedVersion],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, now: Date }} p
 */
export const taskDelegate = (ctx, p) =>
  exec(
    ctx,
    `UPDATE approval_task SET status = 'delegated', acted_at = $1, version = version + 1
      WHERE $t AND id = $2 AND status = 'pending' AND version = $3`,
    [p.now, p.id, p.expectedVersion],
  )

/**
 * 同级其余 pending 任务 → skipped（any 通过时）
 * @param {any} ctx @param {string} instanceId @param {number} stepNo @param {string} exceptId @param {Date} now
 */
export const skipPendingInStep = (ctx, instanceId, stepNo, exceptId, now) =>
  exec(
    ctx,
    `UPDATE approval_task SET status = 'skipped', acted_at = $1, version = version + 1
      WHERE $t AND instance_id = $2 AND step_no = $3 AND status = 'pending' AND id <> $4`,
    [now, instanceId, stepNo, exceptId],
  )

/**
 * 整条实例的 pending 任务 → skipped（reject / withdraw 时）
 * @param {any} ctx @param {string} instanceId @param {Date} now
 */
export const skipPendingInInstance = (ctx, instanceId, now) =>
  exec(
    ctx,
    `UPDATE approval_task SET status = 'skipped', acted_at = $1, version = version + 1
      WHERE $t AND instance_id = $2 AND status = 'pending'`,
    [now, instanceId],
  )

/**
 * 我的待办：显式指派（含已解析成具体人的 role/all）+ role 占位行（approver_user_id IS NULL）
 * @param {any} ctx @param {string} userId
 */
export const pendingTasksOfUser = (ctx, userId) =>
  q(
    ctx,
    `SELECT t.id, t.instance_id, t.step_no, t.approver_user_id, t.status, t.comment, t.version,
            i.status AS instance_status, i.doc_type, i.doc_id, i.current_step, i.submitter_id,
            i.amount, i.flow_snapshot, i.submitted_at
       FROM (SELECT * FROM approval_task WHERE $t AND status = 'pending' AND approver_user_id = $1) t
       JOIN approval_instance i ON i.tenant_id = $2 AND i.id = t.instance_id
      WHERE i.status = 'pending'
      ORDER BY i.submitted_at ASC, t.step_no ASC, t.id ASC`,
    [userId],
  )

/**
 * role 占位任务（无人认领），myTasks 里按 ctx.role.code 匹配快照
 * @param {any} ctx
 */
export const unclaimedTasks = (ctx) =>
  q(
    ctx,
    `SELECT t.id, t.instance_id, t.step_no, t.approver_user_id, t.status, t.comment, t.version,
            i.status AS instance_status, i.doc_type, i.doc_id, i.current_step, i.submitter_id,
            i.amount, i.flow_snapshot, i.submitted_at
       FROM (SELECT * FROM approval_task WHERE $t AND status = 'pending' AND approver_user_id IS NULL) t
       JOIN approval_instance i ON i.tenant_id = $1 AND i.id = t.instance_id
      WHERE i.status = 'pending'
      ORDER BY i.submitted_at ASC, t.step_no ASC, t.id ASC`,
    [],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, instanceId: string, actorId: string | null, action: string, comment: string | null, now: Date }} p
 */
export const eventInsert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO approval_event (tenant_id, id, instance_id, actor_id, action, comment, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.tenantId, p.id, p.instanceId, p.actorId, p.action, p.comment, p.now],
  )

/** @param {any} ctx @param {string} instanceId */
export const eventsByInstance = (ctx, instanceId) =>
  q(
    ctx,
    `SELECT id, instance_id, actor_id, action, comment, at FROM approval_event WHERE $t AND instance_id = $1 ORDER BY at ASC, id ASC`,
    [instanceId],
  )
