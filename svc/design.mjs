import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/design.mjs'
import { assertTransition } from './transition.mjs'

/** 方案状态机：确认后 BOM 冻结（要改就出新版本方案） */
export const TRANSITIONS = { draft: ['confirmed'], confirmed: [] }
export const DESIGN_STATUSES = Object.keys(TRANSITIONS)

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
  version: r.version,
  content: r.content,
  status: r.status,
  confirmedBy: r.confirmed_by,
  confirmedAt: r.confirmed_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lockVersion: r.lock_version,
})

/** @param {any} r */
export const lineToApi = (r) => ({
  id: r.id,
  designDocId: r.design_doc_id,
  lineNo: r.line_no,
  itemName: r.item_name,
  spec: r.spec,
  uom: r.uom,
  qty: Number(r.qty),
  unitCost: Number(r.unit_cost),
  note: r.note,
})

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ projectId?: string }} filters
 */
export async function listDesignDocs(ctx, page, filters) {
  const rows = await store.list(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(toApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getDesignDoc(ctx, id) {
  const docId = assertId(id)
  const row = await store.byId(ctx, docId)
  if (!row) throw new HttpError(errors.notFound)
  const lines = await store.linesByDoc(ctx, docId)
  return { ...toApi(row), bomLines: lines.map(lineToApi) }
}

/** @param {any} tx @param {string} designDocId @param {any[]} lines */
async function replaceLines(tx, designDocId, lines) {
  await store.deleteLines(tx, designDocId)
  for (const l of lines) {
    await store.insertLine(tx, {
      id: randomUUID(),
      designDocId,
      lineNo: l.lineNo,
      itemName: l.itemName,
      spec: l.spec ?? null,
      uom: l.uom ?? null,
      qty: l.qty,
      unitCost: l.unitCost,
      note: l.note ?? null,
    })
  }
}

/**
 * 方案版本号由服务端算：该项目已有方案数 + 1。BOM 行与方案同事务落库。
 * @param {any} ctx
 * @param {{ projectId: string, title: string, content?: string, bomLines: any[] }} input
 */
export async function createDesignDoc(ctx, input) {
  const projectId = assertId(input.projectId)
  if (!(await store.projectExists(ctx, projectId))) {
    throw new HttpError(errors.notFound, { reason: '项目不存在' })
  }
  const now = new Date()
  const id = randomUUID()
  /** @type {number} */
  let version = 1

  await withTx(ctx, async (tx) => {
    const next = /** @type {any} */ (await store.nextVersion(tx, projectId))
    version = Number(next?.v ?? 1)
    await store.insert(tx, {
      id,
      projectId,
      title: input.title,
      version,
      content: input.content ?? null,
      status: 'draft',
      now,
    })
    await replaceLines(tx, id, input.bomLines)
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'design_doc',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'design_doc',
      refId: id,
      before: null,
      after: { projectId, title: input.title, version, lines: input.bomLines.length },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getDesignDoc(ctx, id)
}

/**
 * 只有 draft 能改；带 bomLines 就是整批替换（删旧插新，同事务）。
 * @param {any} ctx
 * @param {string} id
 * @param {{ lockVersion?: number, content?: string, bomLines?: any[] }} patch
 */
export async function updateDesignDoc(ctx, id, patch) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (cur.status !== 'draft') {
    throw new HttpError(errors.conflict, { reason: `方案已 ${cur.status}，只有 draft 可以修改`, allowed: [] })
  }
  // 锁用 lockVersion（业务版号 version 改内容时不变）；客户端不带也能靠下面的原子兜底
  if (patch.lockVersion !== undefined && patch.lockVersion !== cur.lock_version) {
    throw new HttpError(errors.conflict, { reason: `内容已被他人修改（当前 lockVersion ${cur.lock_version}）` })
  }

  const now = new Date()
  const content = patch.content !== undefined ? patch.content : cur.content
  let lineCount = 0

  await withTx(ctx, async (tx) => {
    const n = await store.update(tx, {
      id,
      content,
      expectedLockVersion: cur.lock_version,
      status: 'draft',
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    if (patch.bomLines !== undefined) {
      await replaceLines(tx, id, patch.bomLines)
      lineCount = patch.bomLines.length
    } else {
      lineCount = (await store.linesByDoc(tx, id)).length
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'design_doc',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'design_doc',
      refId: id,
      before: { content: cur.content },
      after: { content, lines: lineCount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getDesignDoc(ctx, id)
}

/**
 * @param {any} ctx @param {string} id @param {string} to
 */
export async function advanceDesignDoc(ctx, id, to) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  assertTransition('design_doc', TRANSITIONS, cur.status, to)

  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.confirm(tx, { id, status: to, from: cur.status, userId: ctx.userId ?? null, now })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'design_doc',
      action: 'advance',
      whoId: ctx.userId ?? null,
      refType: 'design_doc',
      refId: id,
      before: { status: cur.status },
      after: { status: to },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getDesignDoc(ctx, id)
}
