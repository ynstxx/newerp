import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/work.mjs'
import { advanceProject } from './project.mjs'
import { allowedNext, assertTransition } from './transition.mjs'
import { assertId, mustProject } from './work.mjs'

/**
 * 隐蔽验收 / 整体验收：记录验收项与结论。
 * 整体验收通过 → 项目 constructing → pending_acceptance（调 svc/project.advanceProject，状态机只有一份）。
 */

export const ACCEPTANCE_TYPES = /** @type {const} */ (['hidden', 'overall'])
export const ACCEPTANCE_RESULTS = /** @type {const} */ (['pass', 'fail', 'na'])

export const ACCEPTANCE_TRANSITIONS = /** @type {const} */ ({
  draft: ['passed', 'failed'],
  passed: [],
  failed: [],
})

export const ACCEPTANCE_STATUSES = Object.keys(ACCEPTANCE_TRANSITIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {any} r */
export const acceptanceToApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  code: r.code,
  type: r.type,
  status: r.status,
  items: itemsOf(r.items),
  conclusion: r.conclusion,
  acceptedBy: r.accepted_by,
  acceptedAt: r.accepted_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(ACCEPTANCE_TRANSITIONS, r.status),
})

/** @param {unknown} raw 整存整取：不做 JSON 路径查询，读出来一律走这里 */
function itemsOf(raw) {
  const v = typeof raw === 'string' ? JSON.parse(raw) : raw
  return Array.isArray(v) ? v : []
}

/**
 * @param {unknown} raw
 * @returns {{ name: string, result: string, note: string | null }[]}
 */
function normItems(raw) {
  if (!Array.isArray(raw)) throw new HttpError(errors.badRequest, { fields: { items: 'array' } })
  if (raw.length === 0 || raw.length > 100) {
    throw new HttpError(errors.badRequest, { fields: { items: 'length:1..100' } })
  }
  return raw.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      throw new HttpError(errors.badRequest, { fields: { [`items.${i}`]: 'object' } })
    }
    const o = /** @type {Record<string, unknown>} */ (x)
    const extra = Object.keys(o).filter((k) => !['name', 'result', 'note'].includes(k))
    if (extra.length) throw new HttpError(errors.badRequest, { reason: `未知字段 ${extra.join(', ')}` })
    const name = String(o.name ?? '').trim()
    if (!name || name.length > 64) throw new HttpError(errors.badRequest, { fields: { [`items.${i}.name`]: 'string:1..64' } })
    const result = String(o.result ?? '')
    if (!ACCEPTANCE_RESULTS.includes(/** @type {any} */ (result))) {
      throw new HttpError(errors.badRequest, {
        fields: { [`items.${i}.result`]: `enum:${ACCEPTANCE_RESULTS.join('|')}` },
      })
    }
    const note = o.note === undefined || o.note === null || o.note === '' ? null : String(o.note).slice(0, 500)
    return { name, result, note }
  })
}

/** @param {any} ctx @param {string} id */
async function mustAcceptance(ctx, id) {
  const row = await store.accById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return row
}

/** @param {any} ctx @param {any} page @param {any} filters */
export async function listAcceptances(ctx, page, filters) {
  if (filters.projectId && !UUID.test(filters.projectId)) return { items: [], nextCursor: null }
  const rows = await store.accList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(acceptanceToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getAcceptance(ctx, id) {
  return acceptanceToApi(await mustAcceptance(ctx, id))
}

/**
 * @param {any} ctx
 * @param {{ projectId: string, code: string, type: string, items: unknown, conclusion?: string }} input
 */
export async function createAcceptance(ctx, input) {
  const project = await mustProject(ctx, input.projectId)
  const code = normCode(input.code)
  if (await store.accByCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `验收单号 ${code} 已存在` })
  if (!ACCEPTANCE_TYPES.includes(/** @type {any} */ (input.type))) {
    throw new HttpError(errors.badRequest, { fields: { type: `enum:${ACCEPTANCE_TYPES.join('|')}` } })
  }
  const now = new Date()
  const row = {
    id: randomUUID(),
    projectId: project.id,
    code,
    type: input.type,
    items: normItems(input.items),
    conclusion: input.conclusion ?? null,
    now,
  }
  await withTx(ctx, async (tx) => {
    await store.accInsert(tx, row)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'acceptance',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'acceptance',
      refId: row.id,
      before: null,
      after: { code, projectId: row.projectId, type: row.type, items: row.items.length },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getAcceptance(ctx, row.id)
}

/** @param {any} ctx @param {string} id @param {Record<string, any>} patch */
export async function updateAcceptance(ctx, id, patch) {
  const cur = await mustAcceptance(ctx, id)
  if (cur.status !== 'draft') {
    throw new HttpError(errors.conflict, {
      reason: `验收单已是 ${cur.status}，只有 draft 能改`,
      allowed: allowedNext(ACCEPTANCE_TRANSITIONS, cur.status),
    })
  }
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }
  const items = 'items' in patch ? normItems(patch.items) : itemsOf(cur.items)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.accUpdate(tx, {
      id,
      expectedVersion: cur.version,
      items,
      conclusion: 'conclusion' in patch ? patch.conclusion : cur.conclusion,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'acceptance',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'acceptance',
      refId: id,
      before: acceptanceToApi(cur),
      after: { items, conclusion: 'conclusion' in patch ? patch.conclusion : cur.conclusion },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getAcceptance(ctx, id)
}

/**
 * 出结论：passed / failed。整体验收通过 → 项目转 pending_acceptance（同事务）。
 * @param {any} ctx @param {string} id @param {{ to: 'passed'|'failed', conclusion?: string }} input
 */
export async function concludeAcceptance(ctx, id, input) {
  const cur = await mustAcceptance(ctx, id)
  assertTransition('acceptance', ACCEPTANCE_TRANSITIONS, cur.status, input.to)
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.accConclude(tx, {
      id,
      from: cur.status,
      to: input.to,
      acceptedBy: /** @type {string | null} */ (ctx.userId),
      acceptedAt: now,
      conclusion: input.conclusion ?? cur.conclusion,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '验收单已被并发修改，请刷新' })
    if (input.to === 'passed' && cur.type === 'overall') {
      // 项目侧自己再走一次状态机：不是 constructing 就直接 409，不偷偷改状态
      await advanceProject(tx, cur.project_id, {
        to: 'pending_acceptance',
        note: `整体验收通过（${cur.code}）`,
      })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'acceptance',
      action: input.to,
      whoId: ctx.userId ?? null,
      refType: 'acceptance',
      refId: id,
      before: { status: cur.status },
      after: { status: input.to, projectAdvanced: input.to === 'passed' && cur.type === 'overall' },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getAcceptance(ctx, id)
}
