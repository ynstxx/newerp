import * as store from '../store/ticket.mjs'

/**
 * SLA 只做纯计算 + 查询，**不引定时器**（DESIGN 明确砍掉常驻 worker 依赖）。
 * 超时判定由调用方 / 前端轮询 /api/sla/overdue 触发。
 */

export const TICKET_CLOSED = '已关闭'
export const TICKET_PAUSED = '挂起'
export const MINUTE = 60_000

/** @param {Date | string} d */
const asDate = (d) => (d instanceof Date ? d : new Date(d))

/**
 * 到期时刻：未响应按 response_minutes，已响应按 resolve_minutes。
 * @param {{ reportedAt: Date | string | null | undefined, respondedAt: Date | string | null | undefined, responseMinutes: number | null | undefined, resolveMinutes: number | null | undefined }} p
 * @returns {Date | null}
 */
export function slaDueAt(p) {
  const responded = p.respondedAt ? asDate(p.respondedAt) : null
  const base = responded ?? (p.reportedAt ? asDate(p.reportedAt) : null)
  if (!base || Number.isNaN(base.getTime())) return null
  const minutes = Number(responded ? p.resolveMinutes : p.responseMinutes)
  if (!Number.isFinite(minutes) || minutes < 0) return null
  return new Date(base.getTime() + minutes * MINUTE)
}

/**
 * 当前 SLA 口径。挂起期间停止计时；已关闭不再算超时。
 * @param {{ dueAt: Date | string | null | undefined, now: Date, status?: string }} p
 */
export function slaState(p) {
  const due = p.dueAt ? asDate(p.dueAt) : null
  if (!due || Number.isNaN(due.getTime())) {
    return { dueAt: null, overdue: false, paused: p.status === TICKET_PAUSED, closed: p.status === TICKET_CLOSED, overdueMinutes: 0, remainingMinutes: 0 }
  }
  const paused = p.status === TICKET_PAUSED
  const closed = p.status === TICKET_CLOSED
  const diff = due.getTime() - p.now.getTime()
  return {
    dueAt: due,
    paused,
    closed,
    overdue: !paused && !closed && diff <= 0,
    // 已经超时：剩余的分钟数没有意义；未超时：向上取整到分钟，避免显示 0 分钟但实际还有 30 秒
    overdueMinutes: !paused && !closed && diff <= 0 ? Math.ceil(-diff / MINUTE) : 0,
    remainingMinutes: !paused && !closed && diff > 0 ? Math.ceil(diff / MINUTE) : 0,
  }
}

/** @param {Date | string} due @param {number} ms */
export function extendDue(due, ms) {
  return new Date(asDate(due).getTime() + Math.max(0, ms))
}

/** @param {any} r @param {Date} now */
const toOverdueItem = (r, now) => {
  const state = slaState({ dueAt: r.sla_due_at, now, status: r.status })
  return {
    id: r.id,
    code: r.code,
    contractId: r.contract_id,
    partyId: r.party_id,
    title: r.title,
    sn: r.sn,
    priority: r.priority,
    status: r.status,
    assigneeId: r.assignee_id,
    reportedAt: r.reported_at,
    respondedAt: r.responded_at,
    slaDueAt: r.sla_due_at,
    version: r.version,
    overdue: state.overdue,
    overdueMinutes: state.overdueMinutes,
    remainingMinutes: state.remainingMinutes,
  }
}

/**
 * SLA 超时且未关闭的工单。挂起的不返回（暂停计时），关闭的不返回。
 * @param {any} ctx
 * @param {{ now?: Date, limit?: number }} [opts]
 */
export async function overdue(ctx, opts = {}) {
  const now = opts.now ?? new Date()
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
  const rows = await store.overdue(ctx, { now, limit })
  return { now, items: rows.map((/** @type {any} */ r) => toOverdueItem(r, now)) }
}
