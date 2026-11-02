import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

const COLS =
  'id, code, contract_id, party_id, title, content, sn, priority, status, assignee_id, reported_at, responded_at, resolved_at, sla_due_at, version, created_at, updated_at'
const EVENT_COLS = 'id, ticket_id, actor_id, action, comment, at'
const DISPATCH_COLS = 'id, ticket_id, engineer_id, assigned_at, accepted_at, finished_at, note'
const SATISFACTION_COLS = 'id, ticket_id, score, comment, at'
const SPARE_COLS = 'id, ticket_id, item_name, qty, dir, note, at'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM ticket WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const byCode = (ctx, code) => one(ctx, `SELECT ${COLS} FROM ticket WHERE $t AND code = $1`, [code])

/** @param {any} ctx @param {string} id */
export const partyById = (ctx, id) =>
  one(ctx, `SELECT id, code, name, status FROM party WHERE $t AND id = $1`, [id])

/** 工单创建时继承合同 SLA；只读合同，不反向依赖合同 svc。 */
/** @param {any} ctx @param {string} id */
export const contractById = (ctx, id) =>
  one(
    ctx,
    `SELECT id, code, party_id, status, sla_level, response_minutes, resolve_minutes FROM service_contract
      WHERE $t AND id = $1`,
    [id],
  )

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, status?: string, priority?: string, partyId?: string, sn?: string, contractId?: string, keyword?: string }} f
 */
export function list(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []

  if (f.status) {
    args.push(f.status)
    conds.push(`status = $${args.length}`)
  }
  if (f.priority) {
    args.push(f.priority)
    conds.push(`priority = $${args.length}`)
  }
  if (f.partyId) {
    args.push(f.partyId)
    conds.push(`party_id = $${args.length}`)
  }
  if (f.contractId) {
    args.push(f.contractId)
    conds.push(`contract_id = $${args.length}`)
  }
  if (f.sn) {
    args.push(f.sn)
    conds.push(`sn = $${args.length}`)
  }
  if (f.keyword) {
    args.push(`%${f.keyword.toLowerCase()}%`)
    conds.push(
      `(LOWER(title) LIKE $${args.length} OR LOWER(code) LIKE $${args.length} OR LOWER(COALESCE(sn, '')) LIKE $${args.length})`,
    )
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args

  args.push(f.limit + 1)
  const sql =
    `SELECT ${COLS} FROM ticket WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, code: string, contractId: string | null, partyId: string, title: string, content: string | null, sn: string | null, priority: string, status: string, reportedAt: Date, slaDueAt: Date | null, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO ticket
       (tenant_id, id, code, contract_id, party_id, title, content, sn, priority, status, assignee_id,
        reported_at, responded_at, resolved_at, sla_due_at, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, NULL, NULL, $12, 1, $13, $13)`,
    [
      ctx.tenantId,
      p.id,
      p.code,
      p.contractId,
      p.partyId,
      p.title,
      p.content,
      p.sn,
      p.priority,
      p.status,
      p.reportedAt,
      p.slaDueAt,
      p.now,
    ],
  )

/**
 * 所有状态变化都走这一条：status + version 双条件兜底并发。
 * COALESCE 表示「只有传了才写入」，不会把已有的响应/关闭时间清空。
 * @param {any} ctx
 * @param {{ id: string, from: string, to: string, expectedVersion: number, respondedAt?: Date | null, resolvedAt?: Date | null, slaDueAt?: Date | null, assigneeId?: string | null, now: Date }} p
 */
export const transition = (ctx, p) =>
  exec(
    ctx,
    `UPDATE ticket
        SET status = $1,
            responded_at = COALESCE($2, responded_at),
            resolved_at = COALESCE($3, resolved_at),
            sla_due_at = COALESCE($4, sla_due_at),
            assignee_id = COALESCE($5, assignee_id),
            version = version + 1,
            updated_at = $6
      WHERE $t AND id = $7 AND status = $8 AND version = $9`,
    [p.to, p.respondedAt ?? null, p.resolvedAt ?? null, p.slaDueAt ?? null, p.assigneeId ?? null, p.now, p.id, p.from, p.expectedVersion],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, ticketId: string, actorId: string | null, action: string, comment: string | null, at: Date }} p
 */
export const insertEvent = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO ticket_event (tenant_id, id, ticket_id, actor_id, action, comment, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.tenantId, p.id, p.ticketId, p.actorId, p.action, p.comment, p.at],
  )

/** @param {any} ctx @param {string} ticketId */
export const eventsOf = (ctx, ticketId) =>
  q(ctx, `SELECT ${EVENT_COLS} FROM ticket_event WHERE $t AND ticket_id = $1 ORDER BY at ASC, id ASC`, [ticketId])

/** 最近一条挂起/恢复事件：用于判断当前是否处于暂停态，以及恢复回哪个状态。 */
/** @param {any} ctx @param {string} ticketId */
export const lastPauseEvent = (ctx, ticketId) =>
  one(
    ctx,
    `SELECT ${EVENT_COLS} FROM ticket_event
      WHERE $t AND ticket_id = $1 AND action IN ('paused', 'resumed')
      ORDER BY at DESC, id DESC LIMIT 1`,
    [ticketId],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, ticketId: string, engineerId: string, assignedAt: Date, note: string | null }} p
 */
export const insertDispatch = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO dispatch (tenant_id, id, ticket_id, engineer_id, assigned_at, accepted_at, finished_at, note)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6)`,
    [ctx.tenantId, p.id, p.ticketId, p.engineerId, p.assignedAt, p.note],
  )

/** @param {any} ctx @param {string} ticketId */
export const dispatchesOf = (ctx, ticketId) =>
  q(
    ctx,
    `SELECT ${DISPATCH_COLS} FROM dispatch WHERE $t AND ticket_id = $1 ORDER BY assigned_at ASC, id ASC`,
    [ticketId],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, ticketId: string, score: number, comment: string | null, at: Date }} p
 */
export const insertSatisfaction = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO satisfaction (tenant_id, id, ticket_id, score, comment, at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [ctx.tenantId, p.id, p.ticketId, p.score, p.comment, p.at],
  )

/** @param {any} ctx @param {string} ticketId */
export const satisfactionOf = (ctx, ticketId) =>
  one(
    ctx,
    `SELECT ${SATISFACTION_COLS} FROM satisfaction WHERE $t AND ticket_id = $1 ORDER BY at DESC, id DESC LIMIT 1`,
    [ticketId],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, ticketId: string, itemName: string, qty: string, dir: string, note: string | null, at: Date }} p
 */
export const insertSparePart = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO spare_part_move (tenant_id, id, ticket_id, item_name, qty, dir, note, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ctx.tenantId, p.id, p.ticketId, p.itemName, p.qty, p.dir, p.note, p.at],
  )

/** @param {any} ctx @param {string} ticketId */
export const sparePartsOf = (ctx, ticketId) =>
  q(
    ctx,
    `SELECT ${SPARE_COLS} FROM spare_part_move WHERE $t AND ticket_id = $1 ORDER BY at ASC, id ASC`,
    [ticketId],
  )

/** SLA 超时：已关闭/挂起不算（挂起期间 SLA 停止计时）。 */
/** @param {any} ctx @param {{ now: Date, limit: number }} p */
export const overdue = (ctx, p) =>
  q(
    ctx,
    `SELECT ${COLS} FROM ticket
      WHERE $t AND status <> $1 AND status <> $2 AND sla_due_at IS NOT NULL AND sla_due_at <= $3
      ORDER BY sla_due_at ASC, id ASC LIMIT $4`,
    ['已关闭', '挂起', p.now, p.limit],
  )
