import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/quotation.mjs'
import { assertTransition } from './transition.mjs'

/** 报价状态机：M1 无审批，draft → sent → accepted|rejected */
export const TRANSITIONS = /** @type {const} */ ({
  draft: ['sent'],
  sent: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
})

export const QUOTATION_STATUSES = Object.keys(TRANSITIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 */
function assertId(/** @type {string} */ id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/**
 * 金额一律按"分"用整数算，绝不走浮点。输入可以是库里拿到的 "1234.56" 或 JSON 里的 1234.56。
 * 多于两位小数四舍五入（half-up）。
 * @param {unknown} v @returns {number} 整数分
 */
export function centsOf(v) {
  const s = typeof v === 'string' ? v.trim() : String(v ?? '')
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) throw new HttpError(errors.badRequest, { fields: { price: 'money' } })
  const sign = m[1]
  const int = /** @type {string} */ (m[2])
  const frac = /** @type {string} */ (m[3] ?? '')
  const padded = `${frac}000`.slice(0, 3)
  let cents = BigInt(int) * 100n + BigInt(padded.slice(0, 2))
  if (padded[2] >= '5') cents += 1n
  return Number(sign ? -cents : cents)
}

/**
 * 整数分 → "1234.50"（给 numeric(18,2) 列的参数）
 * @param {number} cents
 */
export function moneyOf(cents) {
  const n = Math.trunc(cents)
  const abs = Math.abs(n)
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
  return n < 0 ? `-${s}` : s
}

/**
 * 分 × 分 → 分，乘积除以 100 后四舍五入（BigInt 中间态，不丢精度）
 * @param {number} a @param {number} b
 */
export function mulCents(a, b) {
  const neg = a < 0 !== b < 0
  const p = BigInt(Math.abs(a)) * BigInt(Math.abs(b))
  const rounded = (p + 50n) / 100n
  const n = Number(rounded)
  return neg ? -n : n
}

/**
 * qty × price → 行金额（分）。qty/price 都是库或 JSON 里的原值
 * @param {unknown} qty @param {unknown} price
 */
export function lineAmountCents(qty, price) {
  return mulCents(centsOf(qty), centsOf(price))
}

/** @param {any} r */
export const toApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  code: r.code,
  version: r.version,
  partyId: r.party_id,
  amount: Number(r.amount),
  validUntil: r.valid_until,
  status: r.status,
  sentAt: r.sent_at,
  decidedAt: r.decided_at,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const lineToApi = (r) => ({
  id: r.id,
  lineNo: r.line_no,
  itemName: r.item_name,
  spec: r.spec,
  uom: r.uom,
  qty: Number(r.qty),
  price: Number(r.price),
  amount: Number(r.amount),
  note: r.note,
})

/**
 * 列表：projectId 不是 uuid 就当查不到（不把 PG 类型错误冒成 500）
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ projectId?: string, status?: string }} filters
 */
export async function listQuotations(ctx, page, filters) {
  if (filters.projectId && !UUID.test(filters.projectId)) return { items: [], nextCursor: null }
  const rows = await store.list(ctx, { ...page, projectId: filters.projectId, status: filters.status })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(toApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getQuotation(ctx, id) {
  const row = await store.byId(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const lines = await store.linesByQuotation(ctx, row.id)
  return { ...toApi(row), lines: lines.map(lineToApi) }
}

/**
 * 从已 confirmed 的方案快照出一版报价：行数与 BOM 一致，
 * price 取 priceLines 指定值否则用 bom_line.unit_cost，amount = qty * price。
 * @param {any} ctx
 * @param {{ designDocId: string, code?: string, validUntil?: Date, note?: string, priceLines?: { lineNo: number, price: unknown }[] }} input
 */
export async function createQuotation(ctx, input) {
  const doc = await store.designDocById(ctx, assertId(input.designDocId))
  if (!doc) throw new HttpError(errors.notFound)
  if (doc.status !== 'confirmed') {
    throw new HttpError(errors.conflict, { reason: `方案 ${doc.title} 还是 ${doc.status}，确认后才能出报价` })
  }
  const project = await store.projectById(ctx, doc.project_id)
  if (!project) throw new HttpError(errors.notFound)
  const bom = await store.bomLinesByDesignDoc(ctx, doc.id)
  if (!bom.length) throw new HttpError(errors.badRequest, { reason: '方案没有 BOM 行，无法出报价' })

  const overrides = new Map()
  for (const p of input.priceLines ?? []) {
    if (overrides.has(p.lineNo)) {
      throw new HttpError(errors.badRequest, { fields: { priceLines: `lineNo ${p.lineNo} 重复` } })
    }
    overrides.set(p.lineNo, p.price)
  }
  for (const lineNo of overrides.keys()) {
    if (!bom.some((b) => b.line_no === lineNo)) {
      throw new HttpError(errors.badRequest, { fields: { priceLines: `lineNo ${lineNo} 不在方案 BOM 里` } })
    }
  }

  const lines = bom.map((b) => {
    const price = overrides.has(b.line_no) ? moneyOf(centsOf(overrides.get(b.line_no))) : String(b.unit_cost)
    const amount = lineAmountCents(b.qty, price)
    return {
      id: randomUUID(),
      lineNo: b.line_no,
      itemName: b.item_name,
      spec: b.spec,
      uom: b.uom,
      qty: String(b.qty),
      price,
      amount: moneyOf(amount),
      amountCents: amount,
      note: b.note,
    }
  })
  const totalCents = lines.reduce((s, l) => s + l.amountCents, 0)

  const found = await store.countByProject(ctx, project.id)
  const version = Number(found?.n ?? 0) + 1
  const code = input.code ?? `Q-${doc.id.slice(0, 8)}-${version}`
  if (await store.byCode(ctx, code)) {
    throw new HttpError(errors.conflict, { reason: `报价编码 ${code} 已存在` })
  }

  const id = randomUUID()
  const now = new Date()
  await withTx(ctx, async (tx) => {
    await store.insert(tx, {
      id,
      projectId: project.id,
      code,
      version,
      partyId: project.party_id,
      amount: moneyOf(totalCents),
      validUntil: input.validUntil ?? null,
      status: 'draft',
      sentAt: null,
      decidedAt: null,
      note: input.note ?? null,
      now,
    })
    for (const l of lines) {
      await store.insertLine(tx, {
        id: l.id,
        quotationId: id,
        lineNo: l.lineNo,
        itemName: l.itemName,
        spec: l.spec,
        uom: l.uom,
        qty: l.qty,
        price: l.price,
        amount: l.amount,
        note: l.note,
      })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'quotation',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'quotation',
      refId: id,
      before: null,
      after: { code, version, designDocId: doc.id, projectId: project.id, amount: moneyOf(totalCents), lines: lines.length },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getQuotation(ctx, id)
}

/**
 * 状态推进：非法跳转 409（带 allowed），并发撞车也 409
 * @param {any} ctx @param {string} id @param {string} to
 */
export async function advanceQuotation(ctx, id, to) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  assertTransition('quotation', TRANSITIONS, cur.status, to)

  const now = new Date()
  const row = {
    id,
    from: cur.status,
    status: to,
    sentAt: to === 'sent' ? now : cur.sent_at,
    decidedAt: to === 'accepted' || to === 'rejected' ? now : cur.decided_at,
    now,
  }
  await withTx(ctx, async (tx) => {
    const n = await store.updateStatus(tx, row)
    if (!n) throw new HttpError(errors.conflict, { reason: '状态已被他人修改，请刷新' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'quotation',
      action: 'advance',
      whoId: ctx.userId ?? null,
      refType: 'quotation',
      refId: id,
      before: { status: cur.status },
      after: { status: to },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getQuotation(ctx, id)
}
