import { createHash, randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import * as audit from '../store/audit.mjs'
import * as membership from '../store/membership.mjs'
import * as store from '../store/project.mjs'
import { allowedNext, assertTransition } from './transition.mjs'

/** 项目状态机（M1-DESIGN §2）：quoting→signed 由合同切片联动，这里也允许直接推进 */
export const PROJECT_TRANSITIONS = /** @type {const} */ ({
  draft: ['approved', 'terminated'],
  approved: ['designing', 'terminated'],
  designing: ['quoting', 'approved', 'terminated'],
  quoting: ['signed', 'designing', 'terminated'],
  signed: [],
  terminated: [],
})

export const PROJECT_STATUSES = Object.keys(PROJECT_TRANSITIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 */
function assertId(/** @type {string} */ id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** @param {any} r */
export const toApi = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  partyId: r.party_id,
  opportunityId: r.opportunity_id,
  status: r.status,
  contractAmt: r.contract_amt,
  pmUserId: r.pm_user_id,
  startDate: r.start_date,
  endDate: r.end_date,
  note: r.note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  // 当前状态能去哪 —— 前端据此渲染合法的推进按钮，不再自己抄一份状态机
  allowed: allowedNext(PROJECT_TRANSITIONS, r.status),
})

/** @param {any} r */
const logToApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  fromStatus: r.from_status,
  toStatus: r.to_status,
  actorId: r.actor_id,
  note: r.note,
  at: r.at,
})

/**
 * ISO 字符串/Date → Date。非法值一律 400，别让驱动抛 500。
 * @param {unknown} v @param {string} field
 */
function toDate(v, field) {
  if (v === null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new HttpError(errors.badRequest, { fields: { [field]: 'date' } })
  return d
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ status?: string, keyword?: string }} filters
 */
export async function listProjects(ctx, page, filters) {
  const rows = await store.list(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(toApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getProject(ctx, id) {
  const row = await store.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return toApi(row)
}

/** @param {any} ctx @param {string} id */
export async function listStages(ctx, id) {
  const row = await store.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const rows = await store.stageLogs(ctx, id)
  return { items: rows.map(logToApi) }
}

/**
 * PATCH：名字/项目经理/起止日期/备注，状态只能走 advance。
 * @param {any} ctx
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updateProject(ctx, id, patch) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (cur.status === 'signed' || cur.status === 'terminated') {
    throw new HttpError(errors.conflict, { reason: `${cur.status} 的项目不可再改`, allowed: [] })
  }
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const pmUserId = 'pmUserId' in patch ? (patch.pmUserId ?? null) : cur.pm_user_id
  if (pmUserId !== null && !UUID.test(pmUserId)) {
    throw new HttpError(errors.badRequest, { fields: { pmUserId: 'uuid' } })
  }
  if (pmUserId !== null && !(await membership.memberExists(ctx, pmUserId))) {
    throw new HttpError(errors.badRequest, { fields: { pmUserId: 'not_member' } })
  }

  const now = new Date()
  /** 传了就用传的（null 清空），没传就保留当前值；库里统一是 Date */
  const pickDate = (/** @type {'startDate'|'endDate'} */ key, /** @type {any} */ curVal) => {
    if (!(key in patch)) return curVal ? new Date(curVal) : null
    const v = patch[key]
    return v === null || v === '' ? null : toDate(v, key)
  }
  const row = {
    id,
    expectedVersion: cur.version,
    name: patch.name ?? cur.name,
    pmUserId,
    startDate: pickDate('startDate', cur.start_date),
    endDate: pickDate('endDate', cur.end_date),
    note: 'note' in patch ? patch.note : cur.note,
    now,
  }
  await withTx(ctx, async (tx) => {
    const n = await store.update(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'project',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'project',
      refId: id,
      before: toApi(cur),
      after: { name: row.name, pmUserId: row.pmUserId, startDate: row.startDate, endDate: row.endDate },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getProject(ctx, id)
}

/**
 * 状态推进 + 一条 project_stage_log，同一个事务。
 * @param {any} ctx
 * @param {string} id
 * @param {{ to: string, note?: string | null }} input
 */
export async function advanceProject(ctx, id, input) {
  // signed 只能由合同签署联动产生，否则「零合同也算已签约」——M1 验收要求不可跳级
  if (input.to === 'signed') {
    throw new HttpError(errors.conflict, {
      reason: 'signed 只能由合同签署推进，请走 POST /api/contracts/:id/advance',
      allowed: [],
    })
  }
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)

  assertTransition('project', PROJECT_TRANSITIONS, cur.status, input.to)

  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.setStatus(tx, { id, from: cur.status, to: input.to, now })
    if (!n) throw new HttpError(errors.conflict, { reason: '状态已被并发修改，请重试' })
    await store.insertStageLog(tx, {
      id: randomUUID(),
      projectId: id,
      fromStatus: cur.status,
      toStatus: input.to,
      actorId: ctx.userId ?? null,
      note: input.note ?? null,
      at: now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'project',
      action: 'advance',
      whoId: ctx.userId ?? null,
      refType: 'project',
      refId: id,
      before: { status: cur.status },
      after: { status: input.to },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getProject(ctx, id)
}

/**
 * 商机 won 时调用（**必须在调用方的事务里**）：建 project(draft) + 第一条 stage_log。
 * @param {any} tx 已带 conn 的租户上下文
 * @param {any} opp opportunity 行
 * @param {{ note?: string | null, at: Date }} opts
 */
export async function createProjectForOpportunity(tx, opp, opts) {
  // 派生编码：超长时用短哈希而不是截断 —— 截断会让两个不同商机算出同一个 code
  const derived = `P-${opp.code}`
  const code =
    derived.length <= 64 ? derived : `${derived.slice(0, 55)}-${createHash('sha1').update(opp.code).digest('hex').slice(0, 8)}`
  if (await store.byCode(tx, code)) {
    throw new HttpError(errors.conflict, { reason: `立项编码 ${code} 已存在` })
  }
  const at = opts.at ?? new Date()
  const id = randomUUID()
  await store.insert(tx, {
    id,
    code,
    name: opp.name,
    partyId: opp.party_id,
    opportunityId: opp.id,
    status: 'draft',
    contractAmt: '0.00',
    pmUserId: null,
    startDate: null,
    endDate: null,
    note: opts.note ?? null,
    now: at,
  })
  await store.insertStageLog(tx, {
    id: randomUUID(),
    projectId: id,
    fromStatus: null,
    toStatus: 'draft',
    actorId: tx.userId ?? null,
    note: opts.note ?? null,
    at,
  })
  await audit.insert(tx, {
    id: randomUUID(),
    module: 'project',
    action: 'create',
    whoId: tx.userId ?? null,
    refType: 'project',
    refId: id,
    before: null,
    after: { code, name: opp.name, status: 'draft', opportunityId: opp.id },
    traceId: tx.requestId ?? '',
    at,
  })
  const row = await store.byId(tx, id)
  return toApi(row)
}
