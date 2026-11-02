import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import * as audit from '../store/audit.mjs'
import * as membership from '../store/membership.mjs'
import * as store from '../store/opportunity.mjs'
import { createProjectForOpportunity } from './project.mjs'
import { assertTransition } from './transition.mjs'

/** 商机状态机（M1-DESIGN §2）：won 之后不再流转 */
export const OPPORTUNITY_TRANSITIONS = /** @type {const} */ ({
  new: ['following', 'lost'],
  following: ['won', 'lost'],
  won: [],
  lost: [],
})

export const STAGES = Object.keys(OPPORTUNITY_TRANSITIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 */
function assertId(/** @type {string} */ id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** 日期字符串 → Date（库里统一存 Date，不存 ISO 字符串）。非法值 400。 */
function toDate(/** @type {unknown} */ v, /** @type {string} */ field) {
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new HttpError(errors.badRequest, { fields: { [field]: 'date' } })
  return d
}

/** @param {any} r */
export const toApi = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  partyId: r.party_id,
  ownerId: r.owner_id,
  stage: r.stage,
  estAmount: r.est_amount,
  expectedSignAt: r.expected_sign_at,
  note: r.note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ stage?: string, keyword?: string }} filters
 */
export async function listOpportunities(ctx, page, filters) {
  const rows = await store.list(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(toApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getOpportunity(ctx, id) {
  const row = await store.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return toApi(row)
}

/**
 * 外键指向的客户必须在本租户存在，否则 FK 报错会变成 500。
 * @param {any} ctx
 * @param {string} partyId
 */
async function assertParty(ctx, partyId) {
  if (!UUID.test(partyId)) throw new HttpError(errors.badRequest, { fields: { partyId: 'uuid' } })
  // 跨租户的客户一律按不存在处理（404，不是 400 —— 与 §4.3「越权即不存在」一致）
  if (!(await store.partyExists(ctx, partyId))) throw new HttpError(errors.notFound)
}

/**
 * @param {string | null} ownerId
 */
/** @param {any} ctx @param {string | null} ownerId */
async function assertOwner(ctx, ownerId) {
  if (ownerId === null) return
  if (!UUID.test(ownerId)) throw new HttpError(errors.badRequest, { fields: { ownerId: 'uuid' } })
  if (!(await membership.memberExists(ctx, ownerId))) {
    throw new HttpError(errors.badRequest, { fields: { ownerId: 'not_member' } })
  }
}

/**
 * @param {any} ctx
 * @param {{ code: string, name: string, partyId: string, ownerId?: string | null, estAmount: string, expectedSignAt?: string | null, note?: string | null }} input
 */
export async function createOpportunity(ctx, input) {
  if (await store.byCode(ctx, input.code)) {
    throw new HttpError(errors.conflict, { reason: `商机编码 ${input.code} 已存在` })
  }
  await assertParty(ctx, input.partyId)

  const ownerId = input.ownerId ?? null
  await assertOwner(ctx, ownerId)

  const now = new Date()
  const id = randomUUID()
  const row = {
    id,
    code: input.code,
    name: input.name,
    partyId: input.partyId,
    ownerId,
    stage: 'new',
    estAmount: input.estAmount,
    expectedSignAt: input.expectedSignAt ? toDate(input.expectedSignAt, 'expectedSignAt') : null,
    note: input.note ?? null,
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.insert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'opportunity',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'opportunity',
      refId: id,
      before: null,
      after: { code: row.code, name: row.name, stage: row.stage, estAmount: row.estAmount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getOpportunity(ctx, id)
}

/**
 * PATCH 语义：只改传了的字段。stage 不在这里改 —— 只能走 advance。
 * @param {any} ctx
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updateOpportunity(ctx, id, patch) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  // won/lost 是终态：改客户或编码会打穿已经建出来的项目/报价/合同
  if (cur.stage === 'won' || cur.stage === 'lost') {
    throw new HttpError(errors.conflict, { reason: `${cur.stage} 的商机不可再改`, allowed: [] })
  }
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const code = patch.code ?? cur.code
  if (code !== cur.code && (await store.byCode(ctx, code))) {
    throw new HttpError(errors.conflict, { reason: `商机编码 ${code} 已存在` })
  }
  const partyId = patch.partyId ?? cur.party_id
  if (partyId !== cur.party_id) await assertParty(ctx, partyId)
  const ownerId = 'ownerId' in patch ? (patch.ownerId ?? null) : cur.owner_id
  await assertOwner(ctx, ownerId)

  const now = new Date()
  const row = {
    id,
    expectedVersion: cur.version,
    code,
    name: patch.name ?? cur.name,
    partyId,
    ownerId,
    estAmount: patch.estAmount ?? cur.est_amount,
    expectedSignAt:
      'expectedSignAt' in patch
        ? patch.expectedSignAt
          ? toDate(patch.expectedSignAt, 'expectedSignAt')
          : null
        : cur.expected_sign_at
          ? new Date(cur.expected_sign_at)
          : null,
    note: 'note' in patch ? patch.note : cur.note,
    now,
  }
  await withTx(ctx, async (tx) => {
    const n = await store.update(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'opportunity',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'opportunity',
      refId: id,
      before: toApi(cur),
      after: { code: row.code, name: row.name, stage: cur.stage, estAmount: row.estAmount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getOpportunity(ctx, id)
}

/**
 * 状态推进。won 时**同事务**建 project(draft) + 第一条 stage_log。
 * @param {any} ctx
 * @param {string} id
 * @param {{ to: string, note?: string | null }} input
 */
export async function advanceOpportunity(ctx, id, input) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)

  assertTransition('opportunity', OPPORTUNITY_TRANSITIONS, cur.stage, input.to)

  const now = new Date()
  const note = input.note ?? null
  /** @type {any} */
  let project = null
  await withTx(ctx, async (tx) => {
    const n = await store.setStage(tx, { id, from: cur.stage, to: input.to, now })
    if (!n) throw new HttpError(errors.conflict, { reason: '状态已被并发修改，请重试' })
    if (input.to === 'won') {
      project = await createProjectForOpportunity(tx, cur, { note, at: now })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'opportunity',
      action: 'advance',
      whoId: ctx.userId ?? null,
      refType: 'opportunity',
      refId: id,
      before: { stage: cur.stage },
      after: { stage: input.to, projectId: project ? project.id : null },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  const fresh = await getOpportunity(ctx, id)
  return { ...fresh, project }
}
