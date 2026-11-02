import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/ticket.mjs'
import { allowedNext, assertTransition } from './transition.mjs'
import { extendDue, slaDueAt } from './sla.mjs'

/**
 * DESIGN §7.3 原样落地：
 *   待受理 → 已派工 → 处理中 → 待验证 → 已关闭
 *                          ↘ 挂起（SLA 暂停计时）
 * 「挂起 → 原状态」需要先读暂停事件，因此不放进静态表；由 resume() 单独处理。
 */
export const TICKET_TRANSITIONS = /** @type {const} */ ({
  待受理: ['已派工'],
  已派工: ['处理中', '挂起'],
  处理中: ['待验证', '挂起'],
  待验证: ['已关闭'],
  挂起: [],
  已关闭: [],
})

export const TICKET_STATUSES = Object.keys(TICKET_TRANSITIONS)
export const TICKET_PRIORITIES = /** @type {const} */ (['low', 'normal', 'high', 'urgent'])
export const SPARE_DIRS = /** @type {const} */ (['in', 'out'])

const CLOSED = '已关闭'
const PAUSED = '挂起'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {string} id */
function assertId(id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** @param {any} r */
export const toApi = (r) => ({
  id: r.id,
  code: r.code,
  contractId: r.contract_id,
  partyId: r.party_id,
  title: r.title,
  content: r.content,
  sn: r.sn,
  priority: r.priority,
  status: r.status,
  assigneeId: r.assignee_id,
  reportedAt: r.reported_at,
  respondedAt: r.responded_at,
  resolvedAt: r.resolved_at,
  slaDueAt: r.sla_due_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(TICKET_TRANSITIONS, r.status),
  canResume: r.status === PAUSED,
})

/** @param {any} r */
const eventToApi = (r) => ({
  id: r.id,
  ticketId: r.ticket_id,
  actorId: r.actor_id,
  action: r.action,
  comment: r.comment,
  at: r.at,
})

/** @param {any} r */
const dispatchToApi = (r) => ({
  id: r.id,
  ticketId: r.ticket_id,
  engineerId: r.engineer_id,
  assignedAt: r.assigned_at,
  acceptedAt: r.accepted_at,
  finishedAt: r.finished_at,
  note: r.note,
})

/** @param {any} r */
const satisfactionToApi = (r) => ({ id: r.id, ticketId: r.ticket_id, score: Number(r.score), comment: r.comment, at: r.at })

/** @param {any} r */
const spareToApi = (r) => ({
  id: r.id,
  ticketId: r.ticket_id,
  itemName: r.item_name,
  qty: Number(r.qty),
  dir: r.dir,
  note: r.note,
  at: r.at,
})

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ status?: string, priority?: string, partyId?: string, sn?: string, contractId?: string, keyword?: string }} filters
 */
export async function listTickets(ctx, page, filters) {
  const rows = await store.list(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(toApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getTicket(ctx, id) {
  const row = await store.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const [events, dispatches, satisfaction, spareParts] = await Promise.all([
    store.eventsOf(ctx, id),
    store.dispatchesOf(ctx, id),
    store.satisfactionOf(ctx, id),
    store.sparePartsOf(ctx, id),
  ])
  return {
    ...toApi(row),
    events: events.map(eventToApi),
    dispatches: dispatches.map(dispatchToApi),
    dispatch: dispatches.length ? dispatchToApi(dispatches[dispatches.length - 1]) : null,
    satisfaction: satisfaction ? satisfactionToApi(satisfaction) : null,
    spareParts: spareParts.map(spareToApi),
  }
}

/**
 * 建单：客户可显式传，也可从合同继承；SLA 到期时刻按合同 response_minutes 预计算。
 * @param {any} ctx
 * @param {{ code?: string, contractId?: string | null, partyId?: string, title: string, content?: string | null, sn?: string | null, priority?: string, reportedAt?: Date, slaDueAt?: Date | null }} input
 */
export async function createTicket(ctx, input) {
  const contractId = input.contractId ? assertId(input.contractId) : null
  const contract = contractId ? await store.contractById(ctx, contractId) : null
  if (contractId && !contract) throw new HttpError(errors.notFound)

  const partyId = assertId(input.partyId ?? contract?.party_id ?? '')
  if (!(await store.partyById(ctx, partyId))) throw new HttpError(errors.notFound)

  let code = input.code ? normCode(input.code) : ''
  if (code) {
    if (await store.byCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `工单编号 ${code} 已存在` })
  } else {
    for (let i = 0; i < 5 && !code; i++) {
      const candidate = `T-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
      if (!(await store.byCode(ctx, candidate))) code = candidate
    }
    if (!code) throw new HttpError(errors.conflict, { reason: '工单编号生成冲突，请重试' })
  }

  const reportedAt = input.reportedAt ?? new Date()
  const due = slaDueAt({
    reportedAt,
    respondedAt: null,
    responseMinutes: contract?.response_minutes ?? null,
    resolveMinutes: contract?.resolve_minutes ?? null,
  })
  const now = new Date()
  const id = randomUUID()
  const row = {
    id,
    code,
    contractId,
    partyId,
    title: input.title,
    content: input.content ?? null,
    sn: input.sn ?? null,
    priority: input.priority ?? 'normal',
    status: '待受理',
    reportedAt,
    slaDueAt: due,
    now,
  }

  await withTx(ctx, async (tx) => {
    await store.insert(tx, row)
    await store.insertEvent(tx, {
      id: randomUUID(),
      ticketId: id,
      actorId: ctx.userId ?? null,
      action: 'created',
      comment: `建单：${row.title}`,
      at: now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'ticket:create',
      whoId: ctx.userId ?? null,
      refType: 'ticket',
      refId: id,
      before: null,
      after: { code, title: row.title, sn: row.sn, priority: row.priority, status: row.status, contractId, partyId },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getTicket(ctx, id)
}

/**
 * 状态推进的唯一共用路径：状态 + version 双条件、一条事件、一条审计。
 * @param {any} tx
 * @param {any} cur
 * @param {{ to: string, action: string, comment: string, assigneeId?: string | null, now: Date }} p
 */
async function transitionInTx(tx, cur, p) {
  const contract = cur.contract_id ? await store.contractById(tx, cur.contract_id) : null
  // 离开「待受理」= 首次响应：记录 responded_at，并把 SLA 从响应口径切到解决口径
  const respondedAt = cur.status === '待受理' ? p.now : null
  const resolvedAt = p.to === CLOSED ? p.now : null
  const due =
    respondedAt && contract
      ? slaDueAt({
          reportedAt: cur.reported_at,
          respondedAt,
          responseMinutes: contract.response_minutes,
          resolveMinutes: contract.resolve_minutes,
        })
      : null

  const n = await store.transition(tx, {
    id: cur.id,
    from: cur.status,
    to: p.to,
    expectedVersion: cur.version,
    respondedAt,
    resolvedAt,
    slaDueAt: due,
    assigneeId: p.assigneeId ?? null,
    now: p.now,
  })
  if (!n) {
    throw new HttpError(errors.conflict, {
      reason: '工单状态已被并发修改，请刷新',
      allowed: allowedNext(TICKET_TRANSITIONS, cur.status),
    })
  }
  await store.insertEvent(tx, {
    id: randomUUID(),
    ticketId: cur.id,
    actorId: tx.userId ?? null,
    action: p.action,
    comment: p.comment,
    at: p.now,
  })
  await audit.insert(tx, {
    id: randomUUID(),
    module: 'service',
    action: `ticket:${p.action}`,
    whoId: tx.userId ?? null,
    refType: 'ticket',
    refId: cur.id,
    before: { status: cur.status, version: cur.version },
    after: { status: p.to, respondedAt, resolvedAt, slaDueAt: due, assigneeId: p.assigneeId ?? null },
    traceId: tx.requestId ?? '',
    at: p.now,
  })
}

/**
 * @param {any} ctx
 * @param {string} id
 * @param {{ to: string, comment?: string | null, version?: number }} input
 */
export async function advanceTicket(ctx, id, input) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (input.version !== undefined && input.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  // 挂起不是普通跳转：要先写暂停事件，恢复时才能算暂停时长
  if (input.to === PAUSED) return pauseTicket(ctx, id, { comment: input.comment })

  assertTransition('ticket', TICKET_TRANSITIONS, cur.status, input.to)
  const now = new Date()
  const comment = `${cur.status} → ${input.to}${input.comment ? `：${input.comment}` : ''}`
  await withTx(ctx, async (tx) => {
    await transitionInTx(tx, cur, { to: input.to, action: 'advance', comment, now })
  })
  return getTicket(ctx, id)
}

/**
 * 派工：待受理时同时推进到已派工；已派工可改派（不重复推进状态）。
 * @param {any} ctx
 * @param {string} id
 * @param {{ engineerId: string, note?: string | null }} input
 */
export async function dispatchTicket(ctx, id, input) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  const engineerId = assertId(input.engineerId)
  if (cur.status !== '待受理' && cur.status !== '已派工') {
    throw new HttpError(errors.conflict, {
      reason: `${cur.status} 的工单不能派工`,
      allowed: allowedNext(TICKET_TRANSITIONS, cur.status),
    })
  }
  if (cur.status === '待受理') assertTransition('ticket', TICKET_TRANSITIONS, cur.status, '已派工')

  const now = new Date()
  const to = cur.status === '待受理' ? '已派工' : cur.status
  const comment = `派工 [engineer=${engineerId}]${input.note ? `：${input.note}` : ''}`
  await withTx(ctx, async (tx) => {
    await transitionInTx(tx, cur, { to, action: 'dispatch', comment, assigneeId: engineerId, now })
    await store.insertDispatch(tx, {
      id: randomUUID(),
      ticketId: id,
      engineerId,
      assignedAt: now,
      note: input.note ?? null,
    })
  })
  return getTicket(ctx, id)
}

/**
 * 挂起：工单进入「挂起」，SLA 从此刻起暂停；暂停区间由 paused/resumed 两条事件界定。
 * @param {any} ctx
 * @param {string} id
 * @param {{ comment?: string | null }} [input]
 */
export async function pauseTicket(ctx, id, input = {}) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (cur.status === PAUSED) {
    throw new HttpError(errors.conflict, { reason: '工单已处于挂起状态', allowed: [] })
  }
  assertTransition('ticket', TICKET_TRANSITIONS, cur.status, PAUSED)
  const now = new Date()
  const comment = `挂起 [from=${cur.status}]${input.comment ? `：${input.comment}` : ''}`
  await withTx(ctx, async (tx) => {
    await transitionInTx(tx, cur, { to: PAUSED, action: 'paused', comment, now })
  })
  return getTicket(ctx, id)
}

/**
 * 恢复：把暂停时长补进 sla_due_at（= 保留暂停时刻的剩余时间），回到挂起前状态。
 * @param {any} ctx
 * @param {string} id
 * @param {{ comment?: string | null }} [input]
 */
export async function resumeTicket(ctx, id, input = {}) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (cur.status !== PAUSED) {
    throw new HttpError(errors.conflict, { reason: `工单当前为 ${cur.status}，不在挂起状态`, allowed: [] })
  }
  const last = await store.lastPauseEvent(ctx, id)
  if (!last || last.action !== 'paused') {
    throw new HttpError(errors.conflict, { reason: '找不到有效的暂停事件，无法恢复', allowed: [] })
  }

  const now = new Date()
  const pausedAt = new Date(last.at)
  const pausedMs = Math.max(0, now.getTime() - pausedAt.getTime())
  const m = /\[from=([^\]]+)\]/.exec(String(last.comment ?? ''))
  const prior = m?.[1] && TICKET_STATUSES.includes(m[1]) && m[1] !== PAUSED ? m[1] : '处理中'
  const newDue = cur.sla_due_at ? extendDue(cur.sla_due_at, pausedMs) : null

  await withTx(ctx, async (tx) => {
    const n = await store.transition(tx, {
      id: cur.id,
      from: PAUSED,
      to: prior,
      expectedVersion: cur.version,
      slaDueAt: newDue,
      now,
    })
    if (!n) {
      throw new HttpError(errors.conflict, {
        reason: '工单状态已被并发修改，请刷新',
        allowed: allowedNext(TICKET_TRANSITIONS, PAUSED),
      })
    }
    await store.insertEvent(tx, {
      id: randomUUID(),
      ticketId: id,
      actorId: ctx.userId ?? null,
      action: 'resumed',
      comment: `恢复 [paused_ms=${pausedMs}] [from=${prior}]${input.comment ? `：${input.comment}` : ''}`,
      at: now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'ticket:resume',
      whoId: ctx.userId ?? null,
      refType: 'ticket',
      refId: id,
      before: { status: PAUSED, slaDueAt: cur.sla_due_at, version: cur.version },
      after: { status: prior, slaDueAt: newDue, pausedMs },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getTicket(ctx, id)
}

/**
 * 满意度只能对已关闭工单登记；重复登记保留最新一条（历史不丢，仍在表里）。
 * @param {any} ctx
 * @param {string} id
 * @param {{ score: number, comment?: string | null }} input
 */
export async function addSatisfaction(ctx, id, input) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (cur.status !== CLOSED) {
    throw new HttpError(errors.conflict, {
      reason: `工单 ${cur.status}，只有已关闭工单可以登记满意度`,
      allowed: [CLOSED],
    })
  }
  const score = Number(input.score)
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new HttpError(errors.badRequest, { fields: { score: 'range:1-5' } })
  }

  const now = new Date()
  const satId = randomUUID()
  await withTx(ctx, async (tx) => {
    await store.insertSatisfaction(tx, { id: satId, ticketId: id, score, comment: input.comment ?? null, at: now })
    await store.insertEvent(tx, {
      id: randomUUID(),
      ticketId: id,
      actorId: ctx.userId ?? null,
      action: 'satisfaction',
      comment: `满意度评分 ${score}${input.comment ? `：${input.comment}` : ''}`,
      at: now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'ticket:satisfaction',
      whoId: ctx.userId ?? null,
      refType: 'ticket',
      refId: id,
      before: null,
      after: { score },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getTicket(ctx, id)
}

/**
 * 备件出入登记：自由文本物料，不引库存表、不扣库存。
 * @param {any} ctx
 * @param {string} id
 * @param {{ itemName: string, qty: string, dir: string, note?: string | null }} input
 */
export async function addSparePart(ctx, id, input) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (cur.status === CLOSED) {
    throw new HttpError(errors.conflict, { reason: '已关闭工单不能再登记备件', allowed: [] })
  }
  const now = new Date()
  await withTx(ctx, async (tx) => {
    await store.insertSparePart(tx, {
      id: randomUUID(),
      ticketId: id,
      itemName: input.itemName,
      qty: input.qty,
      dir: input.dir,
      note: input.note ?? null,
      at: now,
    })
    await store.insertEvent(tx, {
      id: randomUUID(),
      ticketId: id,
      actorId: ctx.userId ?? null,
      action: 'spare_part',
      comment: `备件${input.dir === 'in' ? '入库' : '出库'} ${input.itemName} × ${input.qty}`,
      at: now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'ticket:spare_part',
      whoId: ctx.userId ?? null,
      refType: 'ticket',
      refId: id,
      before: null,
      after: { itemName: input.itemName, qty: input.qty, dir: input.dir },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getTicket(ctx, id)
}
