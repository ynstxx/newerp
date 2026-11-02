import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import { nextCode, PREFIX } from './codegen.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/service_contract.mjs'
import { allowedNext, assertTransition } from './transition.mjs'

/**
 * 服务合同状态机：active 到期转 expired，终止只能人工置 terminated。
 * 之前是 PATCH 直写 status —— 终态后能改回来，也拿不到 allowed（审计 B1）。
 */
export const SERVICE_CONTRACT_TRANSITIONS = /** @type {const} */ ({
  active: ['expired', 'terminated'],
  expired: ['terminated'],
  terminated: [],
})
export const CONTRACT_STATUSES = Object.keys(SERVICE_CONTRACT_TRANSITIONS)

/** 已终态/已过期的合同不允许再改条款（会污染新工单的 SLA 预计算） */
const EDITABLE = new Set(['active'])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {string} id */
function assertId(id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

const num = (/** @type {unknown} */ v) => (v === null || v === undefined ? null : Number(v))

/** @param {any} r */
export const toApi = (r) => ({
  id: r.id,
  code: r.code,
  partyId: r.party_id,
  name: r.name,
  startAt: r.start_at,
  endAt: r.end_at,
  slaLevel: r.sla_level,
  responseMinutes: num(r.response_minutes),
  resolveMinutes: num(r.resolve_minutes),
  amount: num(r.amount),
  status: r.status,
  version: r.version,
  allowed: allowedNext(SERVICE_CONTRACT_TRANSITIONS, r.status),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ status?: string, partyId?: string, keyword?: string }} filters
 */
export async function listContracts(ctx, page, filters) {
  const rows = await store.list(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(toApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getContract(ctx, id) {
  const row = await store.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return toApi(row)
}

/**
 * @param {any} ctx
 * @param {{ code: string, partyId: string, name: string, startAt?: Date | null, endAt?: Date | null, slaLevel?: string, responseMinutes?: number, resolveMinutes?: number, amount?: string, status?: string }} input
 */
export async function createContract(ctx, input) {
  const partyId = assertId(input.partyId)
  if (!(await store.partyById(ctx, partyId))) throw new HttpError(errors.notFound)
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.serviceContract)
  if (await store.byCode(ctx, code)) {
    throw new HttpError(errors.conflict, { reason: `服务合同编号 ${code} 已存在` })
  }

  const now = new Date()
  const id = randomUUID()
  const row = {
    id,
    code,
    partyId,
    name: input.name,
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    slaLevel: input.slaLevel ?? 'P2',
    responseMinutes: input.responseMinutes ?? 60,
    resolveMinutes: input.resolveMinutes ?? 480,
    amount: input.amount ?? '0.00',
    status: input.status ?? 'active',
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.insert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'contract:create',
      whoId: ctx.userId ?? null,
      refType: 'service_contract',
      refId: id,
      before: null,
      after: { code: row.code, partyId, name: row.name, slaLevel: row.slaLevel, status: row.status },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getContract(ctx, id)
}

/**
 * @param {any} ctx
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updateContract(ctx, id, patch) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }

  const toStatus = patch.status ?? cur.status
  if (toStatus !== cur.status) assertTransition('service_contract', SERVICE_CONTRACT_TRANSITIONS, cur.status, toStatus)
  // 改条款只在 active 且状态不变时允许；终态或转状态时只接受 status 本身
  const fieldsChanged = ['name', 'startAt', 'endAt', 'slaLevel', 'responseMinutes', 'resolveMinutes', 'amount', 'partyId'].some(
    (k) => patch[k] !== undefined,
  )
  if (fieldsChanged && (!EDITABLE.has(cur.status) || toStatus !== cur.status)) {
    throw new HttpError(errors.conflict, {
      reason: `合同已是 ${cur.status}，条款不可再改（只能改状态）`,
      allowed: allowedNext(SERVICE_CONTRACT_TRANSITIONS, cur.status),
    })
  }

  const code = patch.code !== undefined ? normCode(patch.code) : cur.code
  if (code !== cur.code && (await store.byCode(ctx, code))) {
    throw new HttpError(errors.conflict, { reason: `合同编号 ${code} 已存在` })
  }

  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.update(tx, {
      id,
      code,
      partyId: patch.partyId ?? cur.party_id,
      name: patch.name ?? cur.name,
      startAt: patch.startAt ?? cur.start_at,
      endAt: patch.endAt ?? cur.end_at,
      slaLevel: patch.slaLevel ?? cur.sla_level,
      responseMinutes: patch.responseMinutes ?? cur.response_minutes,
      resolveMinutes: patch.resolveMinutes ?? cur.resolve_minutes,
      amount: patch.amount ?? cur.amount,
      status: toStatus,
      expectedVersion: cur.version,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service_contract',
      action: toStatus !== cur.status ? 'advance' : 'update',
      whoId: ctx.userId ?? null,
      refType: 'service_contract',
      refId: id,
      before: { status: cur.status, name: cur.name },
      after: { status: toStatus, name: patch.name ?? cur.name },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getContract(ctx, id)
}

/** @param {any} ctx @param {string} id */
export async function removeContract(ctx, id) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if ((await store.refs(ctx, id)) > 0) {
    throw new HttpError(errors.conflict, { reason: '合同已被工单或巡检计划引用，不能删除' })
  }
  const now = new Date()
  await withTx(ctx, async (tx) => {
    await store.remove(tx, id)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'contract:delete',
      whoId: ctx.userId ?? null,
      refType: 'service_contract',
      refId: id,
      before: toApi(cur),
      after: null,
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return { ok: true }
}
