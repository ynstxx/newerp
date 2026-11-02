import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { centsOf, moneyOf } from '../http/money.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import { nextCode, PREFIX } from './codegen.mjs'
import * as approvalStore from '../store/approval.mjs'
import * as audit from '../store/audit.mjs'
import * as projectStore from '../store/project.mjs'
import * as store from '../store/work.mjs'
import * as approval from './approval.mjs'
import * as hooks from './approval_hooks.mjs'
import { allowedNext, assertTransition } from './transition.mjs'
import { assertId, mustProject } from './work.mjs'

/**
 * 变更签证：走审批（docType=change_order），通过后累加 project.contract_amt。
 * 落账 SQL 放在 store/work.mjs（store/project.mjs 属 M1，其他 Agent 仍在用）。
 */

export const CHANGE_ORDER_DOC_TYPE = 'change_order'

export const CHANGE_ORDER_TRANSITIONS = /** @type {const} */ ({
  // 暂时没有取消端点，先不暴露 cancelled
  draft: ['pending'],
  pending: ['applied', 'rejected', 'failed'],
  applied: [],
  rejected: [],
  failed: [],
  cancelled: [],
})

export const CHANGE_ORDER_STATUSES = Object.keys(CHANGE_ORDER_TRANSITIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {any} r @param {any} [approval] */
export const changeOrderToApi = (r, approval) => ({
  id: r.id,
  projectId: r.project_id,
  code: r.code,
  title: r.title,
  amount: r.amount,
  reason: r.reason,
  status: r.status,
  approvalInstanceId: r.approval_instance_id,
  approval: approval ?? null,
  appliedAt: r.applied_at,
  errorMessage: r.error_message,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(CHANGE_ORDER_TRANSITIONS, r.status),
})

/** @param {any} ctx @param {string} id */
async function mustChangeOrder(ctx, id) {
  const row = await store.coById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return row
}

/** @param {any} ctx @param {any} page @param {any} filters */
export async function listChangeOrders(ctx, page, filters) {
  if (filters.projectId && !UUID.test(filters.projectId)) return { items: [], nextCursor: null }
  const rows = await store.coList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map((r) => changeOrderToApi(r)), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getChangeOrder(ctx, id) {
  const row = await mustChangeOrder(ctx, id)
  const approval = row.approval_instance_id ? await approvalStore.instanceById(ctx, row.approval_instance_id) : null
  return changeOrderToApi(
    row,
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
 * 建变更签证（draft）。amount 是**增量**，可为负（减项），但不能为 0。
 * @param {any} ctx
 * @param {{ projectId: string, code: string, title: string, amount: unknown, reason?: string }} input
 */
export async function createChangeOrder(ctx, input) {
  const project = await mustProject(ctx, input.projectId)
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.changeOrder)
  if (await store.coByCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `变更单号 ${code} 已存在` })
  const amountCents = centsOf(input.amount)
  if (amountCents === 0) throw new HttpError(errors.badRequest, { fields: { amount: 'non_zero' } })
  const now = new Date()
  const row = {
    id: randomUUID(),
    projectId: project.id,
    code,
    title: input.title,
    amount: moneyOf(amountCents),
    reason: input.reason ?? null,
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.coInsert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'change_order',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'change_order',
      refId: row.id,
      before: null,
      after: { code, projectId: row.projectId, title: row.title, amount: row.amount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getChangeOrder(ctx, row.id)
}

/** @param {any} ctx @param {string} id @param {Record<string, any>} patch */
export async function updateChangeOrder(ctx, id, patch) {
  const cur = await mustChangeOrder(ctx, id)
  if (cur.status !== 'draft') {
    throw new HttpError(errors.conflict, {
      reason: `变更单已是 ${cur.status}，只有 draft 能改`,
      allowed: allowedNext(CHANGE_ORDER_TRANSITIONS, cur.status),
    })
  }
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const amountCents = 'amount' in patch ? centsOf(patch.amount) : centsOf(cur.amount)
  if (amountCents === 0) throw new HttpError(errors.badRequest, { fields: { amount: 'non_zero' } })
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.coUpdate(tx, {
      id,
      expectedVersion: cur.version,
      title: patch.title ?? cur.title,
      amount: moneyOf(amountCents),
      reason: 'reason' in patch ? patch.reason : cur.reason,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'change_order',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'change_order',
      refId: id,
      before: changeOrderToApi(cur),
      after: { title: patch.title ?? cur.title, amount: moneyOf(amountCents), reason: 'reason' in patch ? patch.reason : cur.reason },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getChangeOrder(ctx, id)
}

/** @param {any} ctx @param {string} id */
export async function submitChangeOrder(ctx, id) {
  const cur = await mustChangeOrder(ctx, id)
  if (cur.status !== 'draft') {
    throw new HttpError(errors.conflict, {
      reason: `变更单已是 ${cur.status}，不能重复提交`,
      allowed: allowedNext(CHANGE_ORDER_TRANSITIONS, cur.status),
    })
  }
  assertTransition('change_order', CHANGE_ORDER_TRANSITIONS, cur.status, 'pending')
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const inst = await approval.submit(tx, { docType: CHANGE_ORDER_DOC_TYPE, docId: id, amount: cur.amount })
    const n = await store.coSetStatus(tx, {
      id,
      from: 'draft',
      to: 'pending',
      approvalInstanceId: inst.id,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '变更单已被并发修改，请刷新' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'change_order',
      action: 'submit',
      whoId: ctx.userId ?? null,
      refType: 'change_order',
      refId: id,
      before: { status: cur.status },
      after: { status: 'pending', approvalInstanceId: inst.id, amount: cur.amount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getChangeOrder(ctx, id)
}

// ── 审批钩子 ────────────────────────────────────────────────────────────────

/**
 * 审批通过 → project.contract_amt += amount，并在同一事务写 audit_log。
 * 失败（项目并发/金额为负）→ 变更单落 failed + error_message，错误继续抛出。
 * @param {any} ctx @param {string} _docType @param {string} docId
 */
export async function onChangeOrderApproved(ctx, _docType, docId) {
  const co = await store.coById(ctx, docId)
  if (!co) return
  if (co.status !== 'pending') return

  const now = new Date()
  try {
    const project = await projectStore.byId(ctx, co.project_id)
    if (!project) throw new HttpError(errors.notFound)
    const before = centsOf(project.contract_amt)
    const after = before + centsOf(co.amount)
    if (after < 0) {
      throw new HttpError(errors.conflict, {
        reason: `变更后合同金额不能为负（当前 ${moneyOf(before)}，本次 ${co.amount}）`,
      })
    }
    const n = await store.projectAddContractAmt(ctx, {
      id: project.id,
      expectedVersion: project.version,
      contractAmt: moneyOf(after),
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '项目已被并发修改，请刷新后重试' })
    await store.coSetStatus(ctx, { id: co.id, from: 'pending', to: 'applied', appliedAt: now, now })
    await audit.insert(ctx, {
      id: randomUUID(),
      module: 'change_order',
      action: 'apply',
      whoId: ctx.userId ?? null,
      refType: 'change_order',
      refId: co.id,
      before: { projectId: project.id, contractAmt: moneyOf(before) },
      after: { contractAmt: moneyOf(after), amount: co.amount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  } catch (err) {
    const message =
      err instanceof HttpError
        ? String(/** @type {any} */ (err.details)?.reason ?? err.message).slice(0, 1000)
        : /** @type {Error} */ (err).message
    await store.coSetStatus(ctx, { id: co.id, from: 'pending', to: 'failed', errorMessage: message, now })
    await audit.insert(ctx, {
      id: randomUUID(),
      module: 'change_order',
      action: 'apply_failed',
      whoId: ctx.userId ?? null,
      refType: 'change_order',
      refId: co.id,
      before: { status: co.status },
      after: { status: 'failed', error: message },
      traceId: ctx.requestId ?? '',
      at: now,
    })
    throw err
  }
}

/** @param {any} ctx @param {string} _docType @param {string} docId */
export async function onChangeOrderRejected(ctx, _docType, docId) {
  const co = await store.coById(ctx, docId)
  if (!co || co.status !== 'pending') return
  const now = new Date()
  await store.coSetStatus(ctx, { id: co.id, from: 'pending', to: 'rejected', now })
  await audit.insert(ctx, {
    id: randomUUID(),
    module: 'change_order',
    action: 'reject',
    whoId: ctx.userId ?? null,
    refType: 'change_order',
    refId: co.id,
    before: { status: co.status },
    after: { status: 'rejected' },
    traceId: ctx.requestId ?? '',
    at: now,
  })
}

hooks.register(CHANGE_ORDER_DOC_TYPE, { onApproved: onChangeOrderApproved, onRejected: onChangeOrderRejected })
