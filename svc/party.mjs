import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/party.mjs'

export const PARTY_TYPES = ['customer', 'supplier', 'both']
export const PARTY_STATUSES = ['active', 'disabled']

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
  partyType: r.party_type,
  taxNo: r.tax_no,
  contactName: r.contact_name,
  phone: r.phone,
  email: r.email,
  addr: r.addr,
  status: r.status,
  remark: r.remark,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ partyType?: string, keyword?: string }} filters
 */
export async function listParties(ctx, page, filters) {
  const rows = await store.list(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(toApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getParty(ctx, id) {
  const row = await store.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return toApi(row)
}

/**
 * @param {any} ctx
 * @param {{ code: string, name: string, partyType: string, status?: string, taxNo?: string, contactName?: string, phone?: string, email?: string, addr?: string, remark?: string }} input
 */
export async function createParty(ctx, input) {
  if (await store.byCode(ctx, input.code)) {
    throw new HttpError(errors.conflict, { reason: `编码 ${input.code} 已存在` })
  }
  const now = new Date()
  const id = randomUUID()
  const row = {
    id,
    code: input.code,
    name: input.name,
    partyType: input.partyType,
    status: input.status ?? 'active',
    taxNo: input.taxNo ?? null,
    contactName: input.contactName ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    addr: input.addr ?? null,
    remark: input.remark ?? null,
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.insert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'party',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'party',
      refId: id,
      before: null,
      after: { code: row.code, name: row.name, partyType: row.partyType, status: row.status },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getParty(ctx, id)
}

/**
 * PATCH 语义：只改传了的字段。带 version 就是显式乐观锁校验。
 * @param {any} ctx
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updateParty(ctx, id, patch) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const code = patch.code ?? cur.code
  if (code !== cur.code && (await store.byCode(ctx, code))) {
    throw new HttpError(errors.conflict, { reason: `编码 ${code} 已存在` })
  }

  const now = new Date()
  const row = {
    id,
    expectedVersion: cur.version,
    code,
    name: patch.name ?? cur.name,
    partyType: patch.partyType ?? cur.party_type,
    status: patch.status ?? cur.status,
    taxNo: patch.taxNo ?? cur.tax_no,
    contactName: patch.contactName ?? cur.contact_name,
    phone: patch.phone ?? cur.phone,
    email: patch.email ?? cur.email,
    addr: patch.addr ?? cur.addr,
    remark: patch.remark ?? cur.remark,
    now,
  }

  await withTx(ctx, async (tx) => {
    const n = await store.update(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'party',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'party',
      refId: id,
      before: toApi(cur),
      after: { code: row.code, name: row.name, partyType: row.partyType, status: row.status },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getParty(ctx, id)
}

/** @param {any} ctx @param {string} id */
export async function deleteParty(ctx, id) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.remove(tx, id)
    if (!n) throw new HttpError(errors.notFound)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'party',
      action: 'delete',
      whoId: ctx.userId ?? null,
      refType: 'party',
      refId: id,
      before: toApi(cur),
      after: null,
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
}
