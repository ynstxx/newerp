import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/requirement.mjs'
import { assertTransition } from './transition.mjs'

/** 需求状态机：需求确认后锁定内容，方案版本往上叠 */
export const TRANSITIONS = { draft: ['confirmed'], confirmed: [] }
export const REQUIREMENT_STATUSES = Object.keys(TRANSITIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 */
function assertId(/** @type {string} */ id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** @param {any} r */
export const toApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  content: r.content,
  status: r.status,
  confirmedBy: r.confirmed_by,
  confirmedAt: r.confirmed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  version: r.version,
})

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ projectId?: string, status?: string }} filters
 */
export async function listRequirements(ctx, page, filters) {
  const rows = await store.list(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(toApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getRequirement(ctx, id) {
  const row = await store.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return toApi(row)
}

/**
 * 需求挂在项目上；项目不存在（含跨租户）一律 404。
 * @param {any} ctx
 * @param {{ projectId: string, title: string, content?: string }} input
 */
export async function createRequirement(ctx, input) {
  const projectId = assertId(input.projectId)
  if (!(await store.projectExists(ctx, projectId))) {
    throw new HttpError(errors.notFound, { reason: '项目不存在' })
  }
  const now = new Date()
  const id = randomUUID()
  await withTx(ctx, async (tx) => {
    await store.insert(tx, {
      id,
      projectId,
      title: input.title,
      content: input.content ?? null,
      status: 'draft',
      now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'requirement',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'requirement',
      refId: id,
      before: null,
      after: { projectId, title: input.title, status: 'draft' },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getRequirement(ctx, id)
}

/**
 * PATCH 只改传了的字段。body.version 是乐观锁版本号，不匹配即 409。
 * @param {any} ctx
 * @param {string} id
 * @param {Record<string, any>} patch
 */
export async function updateRequirement(ctx, id, patch) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  // 确认后即锁定：方案 BOM 是照需求快照做的，回头改需求会让下游对不上
  if (cur.status !== 'draft') {
    throw new HttpError(errors.conflict, { reason: `需求已是 ${cur.status}，不可再改`, allowed: [] })
  }
  // 客户端带了 version 就先比一次（早失败、错误更明确）；不带也安全，
  // 下面的 UPDATE 会用服务端读到的 version 做原子兜底
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}）` })
  }

  const now = new Date()
  const row = {
    id,
    title: patch.title ?? cur.title,
    content: patch.content !== undefined ? patch.content : cur.content,
    expectedVersion: cur.version,
    now,
  }
  await withTx(ctx, async (tx) => {
    const n = await store.update(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'requirement',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'requirement',
      refId: id,
      before: toApi(cur),
      after: { title: row.title, content: row.content },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getRequirement(ctx, id)
}

/**
 * 状态推进唯一入口：非法跳转 409（带 allowed），确认时记 confirmed_by/at。
 * @param {any} ctx @param {string} id @param {string} to
 */
export async function advanceRequirement(ctx, id, to) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  assertTransition('requirement', TRANSITIONS, cur.status, to)

  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.confirm(tx, { id, status: to, from: cur.status, userId: ctx.userId ?? null, now })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'requirement',
      action: 'advance',
      whoId: ctx.userId ?? null,
      refType: 'requirement',
      refId: id,
      before: { status: cur.status },
      after: { status: to },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getRequirement(ctx, id)
}
