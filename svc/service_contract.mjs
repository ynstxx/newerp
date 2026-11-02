import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/service_contract.mjs'

/** 服务合同没有复杂状态机：active 到期转 expired，终止只能人工置 terminated。 */
export const CONTRACT_STATUSES = /** @type {const} */ (['active', 'expired', 'terminated'])

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
  const code = normCode(input.code)
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
  const expectedVersion = patch.version ?? cur.version
  if (expectedVersion !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }

  const partyId = patch.partyId !== undefined ? assertId(patch.partyId) : cur.party_id
  if (partyId !== cur.party_id && !(await store.partyById(ctx, partyId))) throw new HttpError(errors.notFound)
  const code = patch.code !== undefined ? normCode(patch.code) : cur.code
  if (code !== cur.code) {
    const dup = await store.byCode(ctx, code)
    if (dup && dup.id !== id) throw new HttpError(errors.conflict, { reason: `服务合同编号 ${code} 已存在` })
  }

  const now = new Date()
  const row = {
    id,
    expectedVersion: cur.version,
    code,
    partyId,
    name: patch.name ?? cur.name,
    startAt: 'startAt' in patch ? patch.startAt : cur.start_at,
    endAt: 'endAt' in patch ? patch.endAt : cur.end_at,
    slaLevel: patch.slaLevel ?? cur.sla_level,
    responseMinutes: patch.responseMinutes ?? cur.response_minutes,
    resolveMinutes: patch.resolveMinutes ?? cur.resolve_minutes,
    amount: patch.amount ?? cur.amount,
    status: patch.status ?? cur.status,
    now,
  }
  await withTx(ctx, async (tx) => {
    const n = await store.update(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'service',
      action: 'contract:update',
      whoId: ctx.userId ?? null,
      refType: 'service_contract',
      refId: id,
      before: toApi(cur),
      after: { ...row, expectedVersion: undefined, now: undefined },
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
