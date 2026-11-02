import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { centsOf, lineAmountCents, moneyOf } from '../http/money.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import { nextCode, PREFIX } from './codegen.mjs'
import * as audit from '../store/audit.mjs'
import * as approvalStore from '../store/approval.mjs'
import * as itemStore from '../store/item.mjs'
import * as store from '../store/work.mjs'
import * as approval from './approval.mjs'
import * as hooks from './approval_hooks.mjs'
import { applyMove } from './stock.mjs'
import { allowedNext, assertTransition } from './transition.mjs'
import { assertId, mustProject } from './work.mjs'

/**
 * 领料（DESIGN §15 M3）：material_issue 走审批，通过后由 hook 调 stock.applyMove 出库。
 *
 * 关键取舍：
 * - 出库**失败不吞**：hook 里标记 material_issue=failed + error_message，然后重新抛出；
 *   审批引擎（svc/approval.mjs）把 approval_instance 落 failed 并记 approval_event，
 *   事务提交后再把原始 409 抛给调用方。
 * - 多明细先按物料聚合成一条 stock_move；中途失败则用反向 applyMove 补偿，不留半边账。
 * - 领料不带 SN（见 docs/work-DESIGN.md）。
 */

export const MATERIAL_ISSUE_DOC_TYPE = 'material_issue'

export const MATERIAL_ISSUE_TRANSITIONS = /** @type {const} */ ({
  draft: ['pending', 'cancelled'],
  pending: ['issued', 'rejected', 'failed'],
  issued: [],
  rejected: [],
  failed: [],
  cancelled: [],
})

export const MATERIAL_ISSUE_STATUSES = Object.keys(MATERIAL_ISSUE_TRANSITIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MOVE_TYPE = 'material_issue'
const MOVE_TYPE_REVERSE = 'material_issue_reverse'

/** @param {any} r @param {any[]} [lines] @param {any} [approval] */
export const issueToApi = (r, lines, approval) => ({
  id: r.id,
  projectId: r.project_id,
  code: r.code,
  warehouseId: r.warehouse_id,
  applicantId: r.applicant_id,
  amount: r.amount,
  status: r.status,
  approvalInstanceId: r.approval_instance_id,
  approval: approval ?? null,
  errorMessage: r.error_message,
  note: r.note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(MATERIAL_ISSUE_TRANSITIONS, r.status),
  lines: lines ?? [],
})

/** @param {any} r */
const lineToApi = (r) => ({
  id: r.id,
  itemId: r.item_id,
  qty: Number(r.qty),
  unitCost: r.unit_cost === null || r.unit_cost === undefined ? null : Number(r.unit_cost),
  note: r.note,
})

/**
 * 明细白名单校验：未知字段 400（与 http/body.only 同一策略）。
 * @param {unknown} raw @param {any} ctx
 */
async function linesOf(ctx, raw) {
  if (!Array.isArray(raw)) throw new HttpError(errors.badRequest, { fields: { lines: 'array' } })
  if (raw.length === 0 || raw.length > 100) {
    throw new HttpError(errors.badRequest, { fields: { lines: 'length:1..100' } })
  }
  /** @type {{ itemId: string, qty: string, unitCost: string | null, note: string | null }[]} */
  const out = []
  for (const [i, x] of raw.entries()) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      throw new HttpError(errors.badRequest, { fields: { [`lines.${i}`]: 'object' } })
    }
    const o = /** @type {Record<string, unknown>} */ (x)
    const extra = Object.keys(o).filter((k) => !['itemId', 'qty', 'unitCost', 'note'].includes(k))
    if (extra.length) throw new HttpError(errors.badRequest, { reason: `未知字段 ${extra.join(', ')}` })
    const itemId = assertId(String(o.itemId ?? ''))
    const item = await itemStore.itemById(ctx, itemId)
    if (!item) throw new HttpError(errors.notFound)
    const qty = centsOf(o.qty, `lines.${i}.qty`)
    if (qty <= 0) throw new HttpError(errors.badRequest, { fields: { [`lines.${i}.qty`]: 'positive' } })
    const unitCostCents = o.unitCost === undefined || o.unitCost === null ? null : centsOf(o.unitCost, `lines.${i}.unitCost`)
    if (unitCostCents !== null && unitCostCents < 0) {
      throw new HttpError(errors.badRequest, { fields: { [`lines.${i}.unitCost`]: 'negative' } })
    }
    const note = o.note === undefined || o.note === null || o.note === '' ? null : String(o.note).slice(0, 500)
    out.push({ itemId, qty: moneyOf(qty), unitCost: unitCostCents === null ? null : moneyOf(unitCostCents), note })
  }
  return out
}

/** @param {any[]} lines */
const computedAmount = (lines) =>
  moneyOf(lines.reduce((sum, l) => sum + lineAmountCents(l.qty, l.unitCost ?? '0'), 0))

/** @param {any} ctx @param {string} id */
async function mustIssue(ctx, id) {
  const row = await store.issueById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return row
}

/** @param {any} ctx @param {any} page @param {any} filters */
export async function listMaterialIssues(ctx, page, filters) {
  if (filters.projectId && !UUID.test(filters.projectId)) return { items: [], nextCursor: null }
  if (filters.warehouseId && !UUID.test(filters.warehouseId)) return { items: [], nextCursor: null }
  const rows = await store.issueList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map((r) => issueToApi(r)), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getMaterialIssue(ctx, id) {
  const row = await mustIssue(ctx, id)
  const [lines, approval] = await Promise.all([
    store.issueLines(ctx, row.id),
    row.approval_instance_id ? approvalStore.instanceById(ctx, row.approval_instance_id) : null,
  ])
  return issueToApi(
    row,
    lines.map(lineToApi),
    approval
      ? {
          id: approval.id,
          status: approval.status,
          currentStep: approval.current_step,
          amount: approval.amount,
          finishedAt: approval.finished_at,
        }
      : null,
  )
}

/**
 * 建领料单（draft）。金额：显式传就按传的，否则按明细 qty×unitCost 现算。
 * @param {any} ctx
 * @param {{ projectId: string, code: string, warehouseId: string, amount?: unknown, note?: string, lines: unknown }} input
 */
export async function createMaterialIssue(ctx, input) {
  const project = await mustProject(ctx, input.projectId)
  const warehouseId = assertId(input.warehouseId)
  if (!(await itemStore.warehouseById(ctx, warehouseId))) throw new HttpError(errors.notFound)
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.materialIssue)
  if (await store.issueByCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `领料单号 ${code} 已存在` })
  const lines = await linesOf(ctx, input.lines)
  let amount
  if (input.amount === undefined || input.amount === null || input.amount === '') {
    amount = computedAmount(lines)
  } else {
    const cents = centsOf(input.amount)
    if (cents < 0) throw new HttpError(errors.badRequest, { fields: { amount: 'negative' } })
    amount = moneyOf(cents)
  }
  const now = new Date()
  const row = {
    id: randomUUID(),
    projectId: project.id,
    code,
    warehouseId,
    applicantId: /** @type {string | null} */ (ctx.userId),
    amount,
    note: input.note ?? null,
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.issueInsert(tx, row)
    for (const l of lines) {
      await store.issueLineInsert(tx, { id: randomUUID(), issueId: row.id, ...l })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'material_issue',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'material_issue',
      refId: row.id,
      before: null,
      after: { code, projectId: row.projectId, warehouseId, amount, lines: lines.length },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getMaterialIssue(ctx, row.id)
}

/** @param {any} ctx @param {string} id @param {Record<string, any>} patch */
export async function updateMaterialIssue(ctx, id, patch) {
  const cur = await mustIssue(ctx, id)
  if (cur.status !== 'draft') {
    throw new HttpError(errors.conflict, {
      reason: `领料单已是 ${cur.status}，只有 draft 能改`,
      allowed: allowedNext(MATERIAL_ISSUE_TRANSITIONS, cur.status),
    })
  }
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  let warehouseId = cur.warehouse_id
  if ('warehouseId' in patch) {
    warehouseId = assertId(patch.warehouseId)
    if (!(await itemStore.warehouseById(ctx, warehouseId))) throw new HttpError(errors.notFound)
  }
  let amount = cur.amount
  const lines = 'lines' in patch ? await linesOf(ctx, patch.lines) : null
  if ('amount' in patch) {
    const cents = centsOf(patch.amount)
    if (cents < 0) throw new HttpError(errors.badRequest, { fields: { amount: 'negative' } })
    amount = moneyOf(cents)
  } else if (lines) {
    amount = computedAmount(lines)
  }
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.issueUpdate(tx, {
      id,
      expectedVersion: cur.version,
      warehouseId,
      amount,
      note: 'note' in patch ? patch.note : cur.note,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    if (lines) {
      await store.issueLinesClear(tx, id)
      for (const l of lines) await store.issueLineInsert(tx, { id: randomUUID(), issueId: id, ...l })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'material_issue',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'material_issue',
      refId: id,
      before: issueToApi(cur),
      after: { warehouseId, amount, lines: lines ? lines.length : undefined },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getMaterialIssue(ctx, id)
}

/**
 * 提交审批：instance 与单据状态同一个事务（approval.submit 复用外层 conn）。
 * @param {any} ctx @param {string} id
 */
export async function submitMaterialIssue(ctx, id) {
  const cur = await mustIssue(ctx, id)
  if (cur.status !== 'draft') {
    throw new HttpError(errors.conflict, {
      reason: `领料单已是 ${cur.status}，不能重复提交`,
      allowed: allowedNext(MATERIAL_ISSUE_TRANSITIONS, cur.status),
    })
  }
  assertTransition('material_issue', MATERIAL_ISSUE_TRANSITIONS, cur.status, 'pending')
  const lines = await store.issueLines(ctx, id)
  if (lines.length === 0) throw new HttpError(errors.badRequest, { reason: '领料单没有明细，不能提交审批' })
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const inst = await approval.submit(tx, { docType: MATERIAL_ISSUE_DOC_TYPE, docId: id, amount: cur.amount })
    const n = await store.issueSetStatus(tx, {
      id,
      from: 'draft',
      to: 'pending',
      approvalInstanceId: inst.id,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '领料单已被并发修改，请刷新' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'material_issue',
      action: 'submit',
      whoId: ctx.userId ?? null,
      refType: 'material_issue',
      refId: id,
      before: { status: cur.status },
      after: { status: 'pending', approvalInstanceId: inst.id, amount: cur.amount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getMaterialIssue(ctx, id)
}

// ── 审批钩子 ────────────────────────────────────────────────────────────────

/**
 * @param {unknown} err
 * @param {string} [itemId]
 */
function reasonOf(err, itemId) {
  const anyErr = /** @type {any} */ (err)
  const base =
    anyErr?.details && typeof anyErr.details.reason === 'string'
      ? anyErr.details.reason
      : anyErr instanceof Error
        ? anyErr.message
        : String(err)
  const available = anyErr?.details?.available
  const parts = [itemId ? `物料 ${itemId} 出库失败` : '出库失败', base]
  if (available !== undefined) parts.push(`当前可用 ${available}`)
  return parts.join('：').slice(0, 1000)
}

/**
 * 审批通过 → 出库。失败必须「可见」：单据落 failed + error_message，错误继续往外抛。
 * @param {any} ctx 审批事务上下文
 * @param {string} _docType
 * @param {string} docId
 */
export async function onIssueApproved(ctx, _docType, docId) {
  const issue = await store.issueById(ctx, docId)
  // 单据被删/已处理：审批结果无处落，静默返回（审批单本身仍会记为 approved）
  if (!issue) return
  if (issue.status !== 'pending') return

  const rows = await store.issueLines(ctx, docId)
  /** @type {Map<string, { cents: number, unitCost: string | null }>} */
  const byItem = new Map()
  for (const l of rows) {
    const qty = centsOf(l.qty, 'qty')
    const cur = byItem.get(l.item_id) ?? { cents: 0, unitCost: null }
    cur.cents += qty
    if (cur.unitCost === null && l.unit_cost !== null && l.unit_cost !== undefined) cur.unitCost = l.unit_cost
    byItem.set(l.item_id, cur)
  }

  const now = new Date()
  /** @type {{ itemId: string, qty: string, unitCost: string | null }[]} */
  const applied = []
  try {
    for (const [itemId, { cents, unitCost }] of byItem) {
      const qty = moneyOf(cents)
      await applyMove(ctx, {
        warehouseId: issue.warehouse_id,
        itemId,
        qty,
        dir: 'out',
        moveType: MOVE_TYPE,
        refType: MATERIAL_ISSUE_DOC_TYPE,
        refId: issue.id,
        unitCost,
      })
      applied.push({ itemId, qty, unitCost })
    }
  } catch (err) {
    // 同一事务内补偿已出库的物料：要么整单出库，要么一行都不动
    let reverseError = ''
    for (const a of applied) {
      try {
        await applyMove(ctx, {
          warehouseId: issue.warehouse_id,
          itemId: a.itemId,
          qty: a.qty,
          dir: 'in',
          moveType: MOVE_TYPE_REVERSE,
          refType: MATERIAL_ISSUE_DOC_TYPE,
          refId: issue.id,
          unitCost: a.unitCost,
        })
      } catch (e) {
        reverseError = `；补偿回滚也失败：${/** @type {Error} */ (e).message}`
      }
    }
    const message = `${reasonOf(err)}${reverseError}`
    await store.issueSetStatus(ctx, { id: issue.id, from: 'pending', to: 'failed', errorMessage: message, now })
    await audit.insert(ctx, {
      id: randomUUID(),
      module: 'material_issue',
      action: 'issue_failed',
      whoId: ctx.userId ?? null,
      refType: 'material_issue',
      refId: issue.id,
      before: { status: issue.status },
      after: { status: 'failed', error: message },
      traceId: ctx.requestId ?? '',
      at: now,
    })
    throw err instanceof HttpError ? err : new HttpError(errors.conflict, { reason: message })
  }

  await store.issueSetStatus(ctx, { id: issue.id, from: 'pending', to: 'issued', now })
  await audit.insert(ctx, {
    id: randomUUID(),
    module: 'material_issue',
    action: 'issue',
    whoId: ctx.userId ?? null,
    refType: 'material_issue',
    refId: issue.id,
    before: { status: issue.status },
    after: { status: 'issued', warehouseId: issue.warehouse_id, items: applied.length, amount: issue.amount },
    traceId: ctx.requestId ?? '',
    at: now,
  })
}

/** @param {any} ctx @param {string} _docType @param {string} docId */
export async function onIssueRejected(ctx, _docType, docId) {
  const issue = await store.issueById(ctx, docId)
  if (!issue || issue.status !== 'pending') return
  const now = new Date()
  await store.issueSetStatus(ctx, { id: issue.id, from: 'pending', to: 'rejected', now })
  await audit.insert(ctx, {
    id: randomUUID(),
    module: 'material_issue',
    action: 'reject',
    whoId: ctx.userId ?? null,
    refType: 'material_issue',
    refId: issue.id,
    before: { status: issue.status },
    after: { status: 'rejected' },
    traceId: ctx.requestId ?? '',
    at: now,
  })
}

hooks.register(MATERIAL_ISSUE_DOC_TYPE, { onApproved: onIssueApproved, onRejected: onIssueRejected })
