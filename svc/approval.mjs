import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { centsOf, moneyOf } from '../http/money.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import * as approvalEvents from './approval_events.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/approval.mjs'
import * as org from '../store/approval_org.mjs'
import * as roles from '../store/role.mjs'
import * as hooks from './approval_hooks.mjs'
import { allowedNext, assertTransition } from './transition.mjs'

/**
 * 审批引擎（DESIGN §9）：有序多级 + 金额档。
 * 不做并行分支 / 会签网关 / 条件表达式 / 图形设计器 / 子流程 / 定时器。
 */

export const INSTANCE_TRANSITIONS = /** @type {const} */ ({
  pending: ['approved', 'rejected', 'withdrawn'],
  // failed = 审批本已通过、但业务钩子落库失败（如领料出库库存不足）。
  // 只有 decide() 的钩子异常路径会写它，普通状态机仍然不允许手工跳。
  approved: [],
  rejected: [],
  withdrawn: [],
  failed: [],
})

export const TASK_TRANSITIONS = /** @type {const} */ ({
  pending: ['approved', 'rejected', 'delegated', 'skipped'],
  approved: [],
  rejected: [],
  delegated: [],
  skipped: [],
})

export const APPROVER_TYPES = ['role', 'user', 'manager']
export const MODES = ['any', 'all']
export const DECIDE_ACTIONS = ['approve', 'reject']

const STEP_FIELDS = ['no', 'approver_type', 'approver_ref', 'mode', 'min_amount', 'max_amount']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {string} id */
function assertId(id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** @param {unknown} v */
const jsonOf = (v) => (typeof v === 'string' ? JSON.parse(v) : v)

/**
 * steps 整存整取，绝不做 JSON 路径查询；读出来一律走这里。
 * @param {unknown} raw
 * @returns {{ no: number, approver_type: string, approver_ref: string | null, mode: string, min_amount: string | null, max_amount: string | null }[]}
 */
function stepsOf(raw) {
  const v = jsonOf(raw)
  if (!Array.isArray(v)) return []
  return v.map((s) => ({
    no: Number(s.no),
    approver_type: String(s.approver_type),
    approver_ref: s.approver_ref === undefined || s.approver_ref === null || s.approver_ref === '' ? null : String(s.approver_ref),
    mode: String(s.mode ?? 'any'),
    min_amount: s.min_amount === undefined || s.min_amount === null ? null : String(s.min_amount),
    max_amount: s.max_amount === undefined || s.max_amount === null ? null : String(s.max_amount),
  }))
}

/** @param {any} row */
function snapshotOf(row) {
  const v = jsonOf(row.flow_snapshot)
  const steps = stepsOf(v?.steps ?? v)
  return { flowId: v?.flowId ?? row.flow_id, flowCode: v?.flowCode ?? null, steps }
}

/** @param {any} s */
const stepToApi = (s) => ({
  no: s.no,
  approverType: s.approver_type,
  approverRef: s.approver_ref,
  mode: s.mode,
  minAmount: s.min_amount,
  maxAmount: s.max_amount,
})

/** @param {any} r */
const flowToApi = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  docType: r.doc_type,
  enabled: Boolean(r.enabled),
  steps: stepsOf(r.steps).map(stepToApi),
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/**
 * @param {any} r
 * @param {any} [snapshot]
 */
const instanceToApi = (r, snapshot = snapshotOf(r)) => ({
  id: r.id,
  flowId: r.flow_id,
  flowCode: snapshot.flowCode,
  docType: r.doc_type,
  docId: r.doc_id,
  status: r.status,
  currentStep: r.current_step,
  amount: r.amount,
  steps: snapshot.steps.map(stepToApi),
  submitterId: r.submitter_id,
  submittedAt: r.submitted_at,
  finishedAt: r.finished_at,
  version: r.version,
  allowed: allowedNext(INSTANCE_TRANSITIONS, r.status),
})

/** @param {any} r @param {boolean} [claimable] */
const taskToApi = (r, claimable = r.approver_user_id === null) => ({
  id: r.id,
  instanceId: r.instance_id,
  stepNo: r.step_no,
  approverUserId: r.approver_user_id,
  claimable,
  status: r.status,
  comment: r.comment,
  version: r.version,
  allowed: allowedNext(TASK_TRANSITIONS, r.status),
  // myTasks 的展开字段（单任务接口没有 instance_* 时自动缺省）
  docType: r.doc_type,
  docId: r.doc_id,
  amount: r.amount,
  submitterId: r.submitter_id,
  submittedAt: r.submitted_at,
  currentStep: r.current_step,
})

/**
 * 步骤声明校验：金额只认 [min,max)（null = 无界），JSON 里仍是 snake_case。
 * @param {unknown} raw
 * @returns {{ no: number, approver_type: string, approver_ref: string | null, mode: string, min_amount: string | null, max_amount: string | null }[]}
 */
export function normSteps(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(errors.badRequest, { fields: { steps: 'non_empty_array' } })
  }
  if (raw.length > 20) throw new HttpError(errors.badRequest, { fields: { steps: 'max:20' } })
  const seen = new Set()
  /** @type {ReturnType<typeof stepsOf>} */
  const out = []
  for (let i = 0; i < raw.length; i++) {
    const s = /** @type {any} */ (raw[i])
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new HttpError(errors.badRequest, { fields: { [`steps.${i}`]: 'object' } })
    }
    const extra = Object.keys(s).filter((k) => !STEP_FIELDS.includes(k))
    if (extra.length) {
      throw new HttpError(errors.badRequest, { reason: `steps.${i} 未知字段 ${extra.join(', ')}` })
    }
    const no = Number(s.no)
    if (!Number.isInteger(no) || no < 1) throw new HttpError(errors.badRequest, { fields: { [`steps.${i}.no`]: 'int>=1' } })
    if (seen.has(no)) throw new HttpError(errors.badRequest, { fields: { [`steps.${i}.no`]: 'duplicate' } })
    seen.add(no)

    const approverType = String(s.approver_type ?? '').trim()
    if (!APPROVER_TYPES.includes(approverType)) {
      throw new HttpError(errors.badRequest, { fields: { [`steps.${i}.approver_type`]: `enum:${APPROVER_TYPES.join('|')}` } })
    }
    let approverRef = s.approver_ref === undefined || s.approver_ref === null ? null : String(s.approver_ref).trim()
    if (approverType === 'manager') approverRef = null
    if (approverType !== 'manager' && !approverRef) {
      throw new HttpError(errors.badRequest, { fields: { [`steps.${i}.approver_ref`]: 'required' } })
    }
    if (approverType === 'user' && !UUID.test(String(approverRef))) {
      throw new HttpError(errors.badRequest, { fields: { [`steps.${i}.approver_ref`]: 'uuid' } })
    }
    if (approverType === 'role' && String(approverRef).length > 64) {
      throw new HttpError(errors.badRequest, { fields: { [`steps.${i}.approver_ref`]: 'max:64' } })
    }
    const mode = String(s.mode ?? 'any').trim()
    if (!MODES.includes(mode)) {
      throw new HttpError(errors.badRequest, { fields: { [`steps.${i}.mode`]: `enum:${MODES.join('|')}` } })
    }
    const money = (/** @type {unknown} */ v, /** @type {string} */ f) => {
      if (v === undefined || v === null || v === '') return null
      try {
        return moneyOf(centsOf(v, f))
      } catch {
        throw new HttpError(errors.badRequest, { fields: { [`steps.${i}.${f}`]: 'money' } })
      }
    }
    const min = money(s.min_amount, 'min_amount')
    const max = money(s.max_amount, 'max_amount')
    if (min !== null && max !== null && centsOf(min) >= centsOf(max)) {
      throw new HttpError(errors.badRequest, { reason: `steps.${i} 的 min_amount 必须小于 max_amount` })
    }
    out.push({ no, approver_type: approverType, approver_ref: approverRef, mode, min_amount: min, max_amount: max })
  }
  return out.sort((a, b) => a.no - b.no)
}

/** @param {any} ctx @param {string} id */
export async function getFlow(ctx, id) {
  const row = await store.flowById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return flowToApi(row)
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ docType?: string, enabled?: boolean }} filters
 */
export async function listFlows(ctx, page, filters) {
  const rows = await store.flowList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(flowToApi), nextCursor }
}

/**
 * @param {any} ctx
 * @param {{ code: string, name: string, docType: string, enabled?: boolean, steps: unknown }} input
 */
export async function createFlow(ctx, input) {
  const code = normCode(input.code)
  const docType = normCode(input.docType)
  const steps = normSteps(input.steps)
  if (await store.flowByCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `流程编码 ${code} 已存在` })
  const now = new Date()
  const id = randomUUID()
  const enabled = input.enabled ?? true
  await withTx(ctx, async (tx) => {
    await store.flowInsert(tx, { id, code, name: input.name, docType, enabled, steps, now })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'approval',
      action: 'flow_create',
      whoId: ctx.userId ?? null,
      refType: 'approval_flow',
      refId: id,
      before: null,
      after: { code, name: input.name, docType, enabled, steps },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getFlow(ctx, id)
}

/**
 * @param {any} ctx
 * @param {string} id
 * @param {{ name?: string, docType?: string, enabled?: boolean, steps?: unknown, version?: number }} patch
 */
export async function updateFlow(ctx, id, patch) {
  const cur = await store.flowById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const row = {
    id,
    expectedVersion: cur.version,
    name: patch.name ?? cur.name,
    docType: patch.docType !== undefined ? normCode(patch.docType) : cur.doc_type,
    enabled: patch.enabled ?? Boolean(cur.enabled),
    steps: patch.steps !== undefined ? normSteps(patch.steps) : stepsOf(cur.steps),
    now: new Date(),
  }
  await withTx(ctx, async (tx) => {
    const n = await store.flowUpdate(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'approval',
      action: 'flow_update',
      whoId: ctx.userId ?? null,
      refType: 'approval_flow',
      refId: id,
      before: { name: cur.name, docType: cur.doc_type, enabled: Boolean(cur.enabled), steps: stepsOf(cur.steps) },
      after: { name: row.name, docType: row.docType, enabled: row.enabled, steps: row.steps },
      traceId: ctx.requestId ?? '',
      at: row.now,
    })
  })
  return getFlow(ctx, id)
}

/** 金额是否落在该级 [min,max) */
function stepApplies(/** @type {any} */ step, /** @type {number} */ cents) {
  if (step.min_amount !== null && cents < centsOf(step.min_amount)) return false
  if (step.max_amount !== null && cents >= centsOf(step.max_amount)) return false
  return true
}

/**
 * 选链规则（DESIGN §9.1「金额阈值触发不同链路」）：
 *  1. 金额落在哪一档 = 最高 applicable 的 step no；链路 = no ≤ 它的全部级（1..N）。
 *  2. 都不落档（例如高于所有 max）→ 退到「不带任何金额区间」的流程，用它的全部级。
 *  3. 仍没有 → 409，绝不静默放行。
 * @param {any[]} flows
 * @param {number} cents
 */
export function pickChain(flows, cents) {
  const parsed = flows.map((f) => ({ flow: f, steps: stepsOf(f.steps) }))
  /** @type {{ flow: any, steps: any[], top: number } | null} */
  let best = null
  for (const p of parsed) {
    let top = 0
    for (const s of p.steps) if (s.no > top && stepApplies(s, cents)) top = s.no
    if (top > 0 && (!best || top > best.top)) best = { flow: p.flow, steps: p.steps, top }
  }
  if (best) return { flow: best.flow, steps: best.steps.filter((s) => s.no <= best.top) }

  const bandless = parsed.find((p) => p.steps.every((s) => s.min_amount === null && s.max_amount === null))
  if (bandless) return { flow: bandless.flow, steps: bandless.steps }
  return null
}

/**
 * 审批人解析（DESIGN §9.4）：role / user / manager。
 * role + mode='any' → 一条 approver_user_id = NULL 的占位任务，该角色任一人可认领；
 * role + mode='all' → 解析成具体成员，每人一条，必须都批。
 * @param {any} ctx
 * @param {any} step
 * @param {string} submitterId
 * @returns {Promise<(string | null)[]>}
 */
async function resolveApprovers(ctx, step, submitterId) {
  if (step.approver_type === 'user') {
    if (!(await org.activeMember(ctx, step.approver_ref))) {
      throw new HttpError(errors.conflict, { reason: `审批人 ${step.approver_ref} 不是本公司有效成员` })
    }
    return [step.approver_ref]
  }
  if (step.approver_type === 'role') {
    const role = await roles.byCode(ctx, step.approver_ref)
    const members = role ? await org.memberIdsByRoleId(ctx, role.id) : []
    if (!members.length) {
      throw new HttpError(errors.conflict, { reason: `审批角色 ${step.approver_ref} 没有有效成员，无法生成审批任务` })
    }
    return step.mode === 'all' ? members.map((m) => m.user_id) : [null]
  }
  if (step.approver_type === 'manager') {
    const mgr = await managerOf(ctx, submitterId)
    return [mgr]
  }
  throw new HttpError(errors.conflict, { reason: `未知审批人类型 ${step.approver_type}` })
}

/**
 * 沿 org_dept 向上找提交人的直属上级；找不到就 409（不允许变成无人可批）。
 * @param {any} ctx @param {string} submitterId
 */
async function managerOf(ctx, submitterId) {
  let dept = await org.deptOfUser(ctx, submitterId)
  if (!dept) {
    throw new HttpError(errors.conflict, { reason: '提交人未归属任何部门（org_dept_member），无法解析 manager 审批人' })
  }
  for (let depth = 0; dept && depth < 20; depth++) {
    const mgr = /** @type {string | null} */ (dept.manager_user_id)
    if (mgr && mgr !== submitterId) {
      if (!(await org.activeMember(ctx, mgr))) {
        throw new HttpError(errors.conflict, { reason: `上级 ${mgr} 不是本公司有效成员` })
      }
      return mgr
    }
    dept = dept.parent_id ? await org.deptById(ctx, dept.parent_id) : null
  }
  throw new HttpError(errors.conflict, { reason: '沿部门树找不到提交人的上级，请先配置 org_dept.manager_user_id' })
}

/**
 * 为某一级建任务
 * @param {any} tx @param {any} instance 行 @param {any} step
 */
async function createStepTasks(tx, instance, step) {
  const approvers = await resolveApprovers(tx, step, instance.submitter_id)
  for (const uid of approvers) {
    await store.taskInsert(tx, {
      id: randomUUID(),
      instanceId: instance.id,
      stepNo: step.no,
      approverUserId: uid,
      now: new Date(),
    })
  }
  return approvers
}

/** @param {any} ctx @param {string} id */
export async function getInstance(ctx, id) {
  const row = await store.instanceById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return instanceToApi(row)
}

/**
 * 提交审批：按 doc_type + amount 选 flow → 快照 → instance + 第 1 级 task。
 * @param {any} ctx
 * @param {{ docType: string, docId: string, amount: string }} input
 */
export async function submit(ctx, input) {
  if (!ctx.userId) throw new HttpError(errors.unauthorized)
  const docType = normCode(input.docType)
  if (!UUID.test(String(input.docId ?? ''))) throw new HttpError(errors.badRequest, { fields: { docId: 'uuid' } })
  const docId = String(input.docId)
  const cents = centsOf(input.amount)
  if (cents < 0) throw new HttpError(errors.badRequest, { fields: { amount: 'non_negative' } })

  const flows = await store.flowsByDocType(ctx, docType)
  const picked = pickChain(flows, cents)
  if (!picked) {
    throw new HttpError(errors.conflict, {
      reason: `单据类型 ${docType} 金额 ${moneyOf(cents)} 没有可用的审批流程（未匹配任何金额档，也没有无区间流程）`,
    })
  }
  if (await store.pendingInstanceByDoc(ctx, docType, docId)) {
    throw new HttpError(errors.conflict, { reason: '该单据已有在途审批' })
  }

  const snapshot = { flowId: picked.flow.id, flowCode: picked.flow.code, steps: picked.steps }
  const first = picked.steps[0]
  const now = new Date()
  const id = randomUUID()

  await withTx(ctx, async (tx) => {
    await store.instanceInsert(tx, {
      id,
      flowId: picked.flow.id,
      docType,
      docId,
      status: 'pending',
      currentStep: first.no,
      amount: moneyOf(cents),
      flowSnapshot: snapshot,
      submitterId: /** @type {string} */ (ctx.userId),
      now,
    })
    const row = await store.instanceById(tx, id)
    await createStepTasks(tx, row, first)
    await store.eventInsert(tx, {
      id: randomUUID(),
      instanceId: id,
      actorId: ctx.userId ?? null,
      action: 'submit',
      comment: null,
      now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'approval',
      action: 'submit',
      whoId: ctx.userId ?? null,
      refType: 'approval_instance',
      refId: id,
      before: null,
      after: { docType, docId, amount: moneyOf(cents), flowCode: picked.flow.code, steps: picked.steps },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  const created = await getInstance(ctx, id)
  // 事务已提交；通知失败不影响审批本身
  await approvalEvents.emit('submitted', ctx, created)
  return created
}

/**
 * 钩子异常 → 人类可读原因（写进 approval_event.comment，前端事件流可见）
 * @param {unknown} err
 */
function hookReason(err) {
  const anyErr = /** @type {any} */ (err)
  const base =
    anyErr?.details && typeof anyErr.details.reason === 'string'
      ? anyErr.details.reason
      : err instanceof Error
        ? err.message
        : String(err)
  return `业务落库失败：${base}`.slice(0, 1000)
}

/**
 * 取任务 + 实例 + 当前级定义，并做授权（跨租户 404 由 store 的 $t 保证，越权 403）
 * @param {any} ctx @param {string} taskId
 */
async function loadTask(ctx, taskId) {
  const task = await store.taskById(ctx, assertId(taskId))
  if (!task) throw new HttpError(errors.notFound)
  const inst = await store.instanceById(ctx, task.instance_id)
  if (!inst) throw new HttpError(errors.notFound)
  const snapshot = snapshotOf(inst)
  const step = snapshot.steps.find((s) => s.no === task.step_no)
  if (!step) throw new HttpError(errors.conflict, { reason: `任务对应的第 ${task.step_no} 级已不在快照里` })

  if (task.approver_user_id === null) {
    const code = ctx.role?.code
    if (!code || code !== step.approver_ref) {
      throw new HttpError(errors.forbidden, { reason: `该级由角色 ${step.approver_ref} 审批` })
    }
  } else if (task.approver_user_id !== ctx.userId) {
    throw new HttpError(errors.forbidden, { reason: '不是你的审批任务' })
  }
  return { task, inst, step, snapshot }
}

/**
 * approve / reject。
 * @param {any} ctx
 * @param {string} taskId
 * @param {{ action: 'approve'|'reject', comment?: string | null }} input
 */
export async function decide(ctx, taskId, input) {
  const { task, inst, step, snapshot } = await loadTask(ctx, taskId)
  const action = input.action
  if (!DECIDE_ACTIONS.includes(action)) {
    throw new HttpError(errors.badRequest, { fields: { action: `enum:${DECIDE_ACTIONS.join('|')}` } })
  }
  if (inst.status !== 'pending') {
    throw new HttpError(errors.conflict, {
      reason: `审批单已是 ${inst.status}，不能再处理`,
      allowed: allowedNext(INSTANCE_TRANSITIONS, inst.status),
    })
  }
  if (task.status !== 'pending') {
    throw new HttpError(errors.conflict, {
      reason: `任务已是 ${task.status}，不能再处理`,
      allowed: allowedNext(TASK_TRANSITIONS, task.status),
    })
  }
  if (task.step_no !== inst.current_step) {
    throw new HttpError(errors.conflict, { reason: `当前在办第 ${inst.current_step} 级，第 ${task.step_no} 级的任务已失效` })
  }

  const comment = input.comment ?? null
  const now = new Date()
  /** 钩子异常先记下，等事务提交后再抛（事务里抛会回滚 failed 标记） */
  /** @type {unknown} */
  let hookError = null
  await withTx(ctx, async (tx) => {
    const n = await store.taskDecide(tx, {
      id: task.id,
      expectedVersion: task.version,
      status: action === 'approve' ? 'approved' : 'rejected',
      comment,
      claimUserId: task.approver_user_id === null ? /** @type {string} */ (ctx.userId) : null,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '任务已被处理或版本已变，请刷新' })
    await store.eventInsert(tx, {
      id: randomUUID(),
      instanceId: inst.id,
      actorId: ctx.userId ?? null,
      action,
      comment,
      now,
    })

    const finish = async (/** @type {string} */ to) => {
      const done = await store.instanceFinish(tx, {
        id: inst.id,
        from: 'pending',
        to,
        expectedVersion: inst.version,
        now,
      })
      if (!done) throw new HttpError(errors.conflict, { reason: '审批单已被并发修改，请刷新' })
      await store.skipPendingInInstance(tx, inst.id, now)
      const row = await store.instanceById(tx, inst.id)
      try {
        await hooks.run(to === 'approved' ? 'approve' : 'reject', tx, row)
      } catch (err) {
        // 业务钩子失败（领料库存不足等）：**不让整个事务回滚** —— 否则审批结果、业务单据的
        // failed 标记、补偿流水全部丢失，错就真被吞了。先把审批单落 failed 并把原因写进
        // approval_event，事务提交后再把原始错误抛给调用方。
        hookError = err
        const reason = hookReason(err)
        const failed = await store.instanceFinish(tx, {
          id: inst.id,
          from: row.status,
          to: 'failed',
          expectedVersion: row.version,
          now,
        })
        if (failed) {
          await store.eventInsert(tx, {
            id: randomUUID(),
            instanceId: inst.id,
            actorId: ctx.userId ?? null,
            action: 'failed',
            comment: reason,
            now,
          })
          await audit.insert(tx, {
            id: randomUUID(),
            module: 'approval',
            action: 'hook_failed',
            whoId: ctx.userId ?? null,
            refType: 'approval_instance',
            refId: inst.id,
            before: { status: row.status },
            after: { status: 'failed', docType: inst.doc_type, docId: inst.doc_id, error: reason },
            traceId: ctx.requestId ?? '',
            at: now,
          })
        }
      }
      return row
    }

    if (action === 'reject') {
      await finish('rejected')
    } else {
      const mode = step.mode
      if (mode === 'any') {
        // 一人通过即过，同级的其他候选任务作废
        await store.skipPendingInStep(tx, inst.id, step.no, task.id, now)
      }
      const rows = await store.tasksByStep(tx, inst.id, step.no)
      // mode='all' 还有人在等 → instance 停在当前级；'any' 的同级候选已在上面作废
      if (!rows.some((r) => r.status === 'pending')) {
        const next = snapshot.steps.filter((s) => s.no > step.no).sort((a, b) => a.no - b.no)[0]
        if (!next) {
          await finish('approved')
        } else {
          const moved = await store.instanceAdvance(tx, {
            id: inst.id,
            from: 'pending',
            step: next.no,
            expectedVersion: inst.version,
            now,
          })
          if (!moved) throw new HttpError(errors.conflict, { reason: '审批单已被并发修改，请刷新' })
          const row = await store.instanceById(tx, inst.id)
          await createStepTasks(tx, row, next)
        }
      }
    }

    await audit.insert(tx, {
      id: randomUUID(),
      module: 'approval',
      action,
      whoId: ctx.userId ?? null,
      refType: 'approval_task',
      refId: task.id,
      before: { instanceStatus: inst.status, taskStatus: task.status, step: task.step_no },
      after: { action, comment },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  // 业务落库失败：审批单已按 failed 提交，错误照样往外抛（不吞）
  if (hookError) {
    await approvalEvents.emit('decided', ctx, { instance: await getInstance(ctx, inst.id), action })
    throw hookError
  }
  const done = await getInstance(ctx, inst.id)
  await approvalEvents.emit('decided', ctx, { instance: done, action })
  return done
}

/**
 * 提交人撤回
 * @param {any} ctx @param {string} instanceId
 */
export async function withdraw(ctx, instanceId) {
  const inst = await store.instanceById(ctx, assertId(instanceId))
  if (!inst) throw new HttpError(errors.notFound)
  if (inst.submitter_id !== ctx.userId) {
    throw new HttpError(errors.forbidden, { reason: '只有提交人可以撤回' })
  }
  assertTransition('approval_instance', INSTANCE_TRANSITIONS, inst.status, 'withdrawn')
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.instanceFinish(tx, {
      id: inst.id,
      from: inst.status,
      to: 'withdrawn',
      expectedVersion: inst.version,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '审批单已被并发修改，请刷新' })
    await store.skipPendingInInstance(tx, inst.id, now)
    await store.eventInsert(tx, {
      id: randomUUID(),
      instanceId: inst.id,
      actorId: ctx.userId ?? null,
      action: 'withdraw',
      comment: null,
      now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'approval',
      action: 'withdraw',
      whoId: ctx.userId ?? null,
      refType: 'approval_instance',
      refId: inst.id,
      before: { status: inst.status },
      after: { status: 'withdrawn' },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getInstance(ctx, inst.id)
}

/**
 * 转办：原任务 → delegated，同一级给目标人新建一条 pending。
 * @param {any} ctx @param {string} taskId @param {string} toUserId
 */
export async function delegate(ctx, taskId, toUserId) {
  const { task, inst } = await loadTask(ctx, taskId)
  if (inst.status !== 'pending') {
    throw new HttpError(errors.conflict, {
      reason: `审批单已是 ${inst.status}，不能转办`,
      allowed: allowedNext(INSTANCE_TRANSITIONS, inst.status),
    })
  }
  if (task.status !== 'pending') {
    throw new HttpError(errors.conflict, {
      reason: `任务已是 ${task.status}，不能转办`,
      allowed: allowedNext(TASK_TRANSITIONS, task.status),
    })
  }
  if (task.step_no !== inst.current_step) {
    throw new HttpError(errors.conflict, { reason: `当前在办第 ${inst.current_step} 级，第 ${task.step_no} 级的任务已失效` })
  }
  const target = String(toUserId ?? '').trim()
  if (!UUID.test(target)) throw new HttpError(errors.badRequest, { fields: { toUserId: 'uuid' } })
  if (target === ctx.userId) throw new HttpError(errors.badRequest, { fields: { toUserId: 'self' } })
  if (!(await org.activeMember(ctx, target))) {
    throw new HttpError(errors.badRequest, { fields: { toUserId: 'not_member' } })
  }

  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.taskDelegate(tx, { id: task.id, expectedVersion: task.version, now })
    if (!n) throw new HttpError(errors.conflict, { reason: '任务已被处理或版本已变，请刷新' })
    await store.taskInsert(tx, {
      id: randomUUID(),
      instanceId: inst.id,
      stepNo: task.step_no,
      approverUserId: target,
      now,
    })
    await store.eventInsert(tx, {
      id: randomUUID(),
      instanceId: inst.id,
      actorId: ctx.userId ?? null,
      action: 'delegate',
      comment: `to:${target}`,
      now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'approval',
      action: 'delegate',
      whoId: ctx.userId ?? null,
      refType: 'approval_task',
      refId: task.id,
      before: { approverUserId: task.approver_user_id },
      after: { approverUserId: target },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getInstance(ctx, inst.id)
}

/**
 * 我的待办：approver_user_id = 我 且 pending；
 * role 型（approver_type='role'）按 ctx.role.code 匹配快照里的占位任务一并返回。
 * @param {any} ctx
 */
export async function myTasks(ctx) {
  if (!ctx.userId) throw new HttpError(errors.unauthorized)
  const rows = await store.pendingTasksOfUser(ctx, ctx.userId)
  const out = rows.filter((r) => r.step_no === r.current_step).map((r) => taskToApi(r))

  const roleCode = ctx.role?.code
  if (roleCode) {
    const claimed = new Set(out.map((t) => t.id))
    for (const r of await store.unclaimedTasks(ctx)) {
      if (r.step_no !== r.current_step || claimed.has(r.id)) continue
      const snap = snapshotOf(r)
      const step = snap.steps.find((s) => s.no === r.current_step)
      if (!step || step.approver_type !== 'role' || step.approver_ref !== roleCode) continue
      out.push(taskToApi(r, true))
    }
  }
  return { items: out, nextCursor: null }
}

/** 审批流水（诊断/详情页用） @param {any} ctx @param {string} instanceId */
export async function listEvents(ctx, instanceId) {
  const inst = await store.instanceById(ctx, assertId(instanceId))
  if (!inst) throw new HttpError(errors.notFound)
  const rows = await store.eventsByInstance(ctx, inst.id)
  return {
    items: rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      actorId: r.actor_id,
      action: r.action,
      comment: r.comment,
      at: r.at,
    })),
    nextCursor: null,
  }
}
