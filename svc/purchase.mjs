import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { centsOf, moneyOf, mulCents } from '../http/money.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import { nextCode, PREFIX } from './codegen.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/purchase.mjs'
import * as hooks from './approval_hooks.mjs'
import * as approval from './approval.mjs'
import { applyMove } from './stock.mjs'
import { allowedNext, assertTransition } from './transition.mjs'

/**
 * M4 采购 + 财务（DESIGN §7.2 / §15）。
 *
 * 一条主线的记账顺序（与手工账一致）：
 *   建 PO（金额=行合计）→ 提交审批 → 通过 → 收货（库存 + 成本入库 + 应付承诺）
 *   分包合同审批（应付）→ 进度款审批（成本归集）
 *   合同登记应收 → 开票 → 收款核销（台账负数）
 *   项目毛利 = 合同额 - cost_line 合计
 *
 * 明确不做：财务凭证/总账科目、付款的银行对接、通知（DESIGN §15 M4 边界）。
 */

// ── 状态机 ──────────────────────────────────────────────────────────────────
export const PO_TRANSITIONS = /** @type {const} */ ({
  draft: ['pending'],
  pending: ['approved', 'rejected'],
  rejected: ['pending'],
  approved: ['closed'],
  closed: [],
})
export const PO_STATUSES = Object.keys(PO_TRANSITIONS)

export const SUB_TRANSITIONS = /** @type {const} */ ({
  draft: ['pending'],
  pending: ['approved', 'rejected'],
  rejected: ['pending'],
  approved: ['closed'],
  closed: [],
})
export const SUB_STATUSES = Object.keys(SUB_TRANSITIONS)

export const PROGRESS_TRANSITIONS = /** @type {const} */ ({
  draft: ['pending'],
  pending: ['approved', 'rejected'],
  rejected: ['pending'],
  approved: [],
})
export const PROGRESS_STATUSES = Object.keys(PROGRESS_TRANSITIONS)

export const INVOICE_KINDS = ['ar', 'ap']
export const PAYMENT_KINDS = ['ar', 'ap']
export const PAYMENT_METHODS = ['bank', 'cash', 'cheque', 'other']
export const COST_SOURCES = ['purchase', 'subcontract', 'labor', 'other']

/** 审批 doc_type：与 APPROVAL_FLOW.doc_type 对齐 */
export const DOC_PO = 'purchase_order'
export const DOC_SUB = 'subcontract'
export const DOC_PROGRESS = 'subcontract_progress'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 */
function assertId(/** @type {unknown} */ id) {
  const s = String(id ?? '')
  if (!UUID.test(s)) throw new HttpError(errors.notFound)
  return s
}

/** money 在 PG/MySQL 两个驱动里都是字符串，对外统一成数字 */
const num = (/** @type {unknown} */ v) => (v === null || v === undefined ? null : Number(v))

/** @param {unknown} raw @param {string} field */
function dateOf(/** @type {unknown} */ raw, /** @type {string} */ field) {
  if (raw === undefined || raw === null || raw === '') return null
  const d = raw instanceof Date ? raw : new Date(String(raw))
  if (Number.isNaN(d.getTime())) throw new HttpError(errors.badRequest, { fields: { [field]: 'time' } })
  return d
}

/** 金额必须 > 0（分整数比较，不走浮点） */
function positiveCents(/** @type {unknown} */ v, /** @type {string} */ field) {
  const c = centsOf(v, field)
  if (c <= 0) throw new HttpError(errors.badRequest, { fields: { [field]: 'positive' } })
  return c
}

/** 金额可以 = 0（单价 0、合同 0 元赠送） */
function nonNegativeCents(/** @type {unknown} */ v, /** @type {string} */ field) {
  const c = centsOf(v, field)
  if (c < 0) throw new HttpError(errors.badRequest, { fields: { [field]: 'negative' } })
  return c
}

/**
 * 一个对象数组的严格校验：未知键 → 400（和顶层 only() 同样的规则）。
 * @param {unknown} raw @param {string[]} keys @param {string} field
 * @returns {any[]}
 */
function objectArray(/** @type {unknown} */ raw, /** @type {string[]} */ keys, /** @type {string} */ field) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(errors.badRequest, { fields: { [field]: 'non_empty_array' } })
  }
  if (raw.length > 200) throw new HttpError(errors.badRequest, { fields: { [field]: 'max:200' } })
  return raw.map((x, i) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      throw new HttpError(errors.badRequest, { fields: { [`${field}.${i}`]: 'object' } })
    }
    const extra = Object.keys(x).filter((k) => !keys.includes(k))
    if (extra.length) throw new HttpError(errors.badRequest, { reason: `${field}.${i} 未知字段 ${extra.join(', ')}` })
    return x
  })
}

// ── API 映射 ────────────────────────────────────────────────────────────────
/** @param {any} r */
export const poToApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  partyId: r.party_id,
  code: r.code,
  amount: num(r.amount),
  status: r.status,
  note: r.note,
  approvedAt: r.approved_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(PO_TRANSITIONS, r.status),
})

/** @param {any} r */
const poLineToApi = (r) => ({
  id: r.id,
  lineNo: r.line_no,
  itemId: r.item_id,
  qty: num(r.qty),
  price: num(r.price),
  amount: num(r.amount),
})

/** @param {any} r */
export const receiptToApi = (r) => ({
  id: r.id,
  poId: r.po_id,
  warehouseId: r.warehouse_id,
  code: r.code,
  status: r.status,
  receivedAt: r.received_at,
  note: r.note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {any} r */
const grnLineToApi = (r) => ({
  id: r.id,
  poLineId: r.po_line_id,
  itemId: r.item_id,
  qty: num(r.qty),
  price: num(r.price),
  amount: num(r.amount),
})

/** @param {any} r */
export const subToApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  partyId: r.party_id,
  code: r.code,
  name: r.name,
  amount: num(r.amount),
  status: r.status,
  note: r.note,
  approvedAt: r.approved_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(SUB_TRANSITIONS, r.status),
})

/** @param {any} r */
export const progressToApi = (r) => ({
  id: r.id,
  subcontractId: r.subcontract_id,
  seq: r.seq,
  amount: num(r.amount),
  status: r.status,
  note: r.note,
  approvedAt: r.approved_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(PROGRESS_TRANSITIONS, r.status),
})

/** @param {any} r */
export const invoiceToApi = (r) => ({
  id: r.id,
  kind: r.kind,
  partyId: r.party_id,
  projectId: r.project_id,
  contractId: r.contract_id,
  poId: r.po_id,
  subcontractId: r.subcontract_id,
  code: r.code,
  amount: num(r.amount),
  status: r.status,
  issuedAt: r.issued_at,
  note: r.note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const paymentToApi = (r) => ({
  id: r.id,
  kind: r.kind,
  partyId: r.party_id,
  projectId: r.project_id,
  amount: num(r.amount),
  method: r.method,
  paidAt: r.paid_at,
  note: r.note,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const arToApi = (r) => ({
  id: r.id,
  partyId: r.party_id,
  projectId: r.project_id,
  contractId: r.contract_id,
  invoiceId: r.invoice_id,
  entryType: r.entry_type,
  amount: num(r.amount),
  refType: r.ref_type,
  refId: r.ref_id,
  note: r.note,
  at: r.at,
  createdAt: r.created_at,
})

/** @param {any} r */
export const apToApi = (r) => ({
  id: r.id,
  partyId: r.party_id,
  projectId: r.project_id,
  poId: r.po_id,
  subcontractId: r.subcontract_id,
  invoiceId: r.invoice_id,
  entryType: r.entry_type,
  amount: num(r.amount),
  refType: r.ref_type,
  refId: r.ref_id,
  note: r.note,
  at: r.at,
  createdAt: r.created_at,
})

/** @param {any} r */
export const costToApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  source: r.source,
  refType: r.ref_type,
  refId: r.ref_id,
  amount: num(r.amount),
  note: r.note,
  at: r.at,
  createdAt: r.created_at,
})

// ── 审批回调（DESIGN §9.3：回调在 decide 的事务内执行） ──────────────────────
/**
 * 采购单审批通过 = 应付承诺成立（ap_ledger 正数），**不是成本**：
 * 成本要等收货（grn_line）才归集，否则同一笔钱会在 PO 与收货里各算一次。
 */
hooks.register(DOC_PO, {
  onApproved: async (/** @type {any} */ tx, /** @type {string} */ _docType, /** @type {string} */ docId) => {
    const now = new Date()
    const n = await store.poSetStatus(tx, { id: docId, from: 'pending', to: 'approved', approvedAt: now, now })
    if (!n) return // 重复回调或状态已变：不二次入账
    const row = await store.poById(tx, docId)
    if (!row) return
    await store.apInsert(tx, {
      id: randomUUID(),
      partyId: row.party_id,
      projectId: row.project_id,
      poId: row.id,
      subcontractId: null,
      invoiceId: null,
      entryType: 'purchase_order',
      amount: row.amount,
      refType: 'purchase_order',
      refId: row.id,
      note: `采购单 ${row.code} 审批通过`,
      at: now,
    })
  },
  onRejected: async (/** @type {any} */ tx, /** @type {string} */ _docType, /** @type {string} */ docId) => {
    await store.poSetStatus(tx, { id: docId, from: 'pending', to: 'rejected', now: new Date() })
  },
})

hooks.register(DOC_SUB, {
  onApproved: async (/** @type {any} */ tx, /** @type {string} */ _docType, /** @type {string} */ docId) => {
    const now = new Date()
    const n = await store.subSetStatus(tx, { id: docId, from: 'pending', to: 'approved', approvedAt: now, now })
    if (!n) return
    const row = await store.subById(tx, docId)
    if (!row) return
    await store.apInsert(tx, {
      id: randomUUID(),
      partyId: row.party_id,
      projectId: row.project_id,
      poId: null,
      subcontractId: row.id,
      invoiceId: null,
      entryType: 'subcontract',
      amount: row.amount,
      refType: 'subcontract',
      refId: row.id,
      note: `分包合同 ${row.code} 审批通过`,
      at: now,
    })
  },
  onRejected: async (/** @type {any} */ tx, /** @type {string} */ _docType, /** @type {string} */ docId) => {
    await store.subSetStatus(tx, { id: docId, from: 'pending', to: 'rejected', now: new Date() })
  },
})

/** 进度款审批通过 = 分包成本真实发生，写 cost_line（项目毛利据此计算） */
hooks.register(DOC_PROGRESS, {
  onApproved: async (/** @type {any} */ tx, /** @type {string} */ _docType, /** @type {string} */ docId) => {
    const now = new Date()
    const n = await store.progressSetStatus(tx, {
      id: docId,
      from: 'pending',
      to: 'approved',
      approvedAt: now,
      now,
    })
    if (!n) return
    const row = await store.progressById(tx, docId)
    if (!row) return
    const sub = await store.subById(tx, row.subcontract_id)
    if (!sub) return
    await store.costInsert(tx, {
      id: randomUUID(),
      projectId: sub.project_id,
      source: 'subcontract',
      refType: 'subcontract_progress',
      refId: row.id,
      amount: moneyOf(centsOf(row.amount)),
      note: `分包 ${sub.code} 第 ${row.seq} 期进度款`,
      at: now,
    })
  },
  onRejected: async (/** @type {any} */ tx, /** @type {string} */ _docType, /** @type {string} */ docId) => {
    await store.progressSetStatus(tx, { id: docId, from: 'pending', to: 'rejected', now: new Date() })
  },
})

// ── 采购单 ──────────────────────────────────────────────────────────────────
/**
 * @param {unknown} raw
 * @returns {{ itemId: string, qty: string, price: string, amount: string }[]}
 */
function normPoLines(/** @type {unknown} */ raw) {
  const rows = objectArray(raw, ['itemId', 'qty', 'price'], 'lines')
  return rows.map((x, i) => {
    const itemId = assertId(x.itemId)
    const qty = positiveCents(x.qty, `lines.${i}.qty`)
    const price = nonNegativeCents(x.price, `lines.${i}.price`)
    return { itemId, qty: moneyOf(qty), price: moneyOf(price), amount: moneyOf(mulCents(qty, price)) }
  })
}

/**
 * 建采购单：金额**只由行合计得出**，客户端传 amount 会被 only() 挡掉。
 * @param {any} ctx
 * @param {{ projectId?: string, partyId: string, code: string, note?: string, lines: unknown }} input
 */
export async function createPo(ctx, input) {
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.purchaseOrder)
  if (await store.poByCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `采购单号 ${code} 已存在` })
  const partyId = assertId(input.partyId)
  if (!(await store.partyExists(ctx, partyId))) {
    throw new HttpError(errors.badRequest, { fields: { partyId: 'not_found' } })
  }
  const projectId = input.projectId ? assertId(input.projectId) : null
  if (projectId && !(await store.projectExists(ctx, projectId))) {
    throw new HttpError(errors.badRequest, { fields: { projectId: 'not_found' } })
  }
  const lines = normPoLines(input.lines)
  const total = lines.reduce((s, l) => s + centsOf(l.amount), 0)
  const now = new Date()
  const id = randomUUID()

  await withTx(ctx, async (tx) => {
    for (let i = 0; i < lines.length; i++) {
      const l = /** @type {any} */ (lines[i])
      if (!(await store.itemExists(tx, l.itemId))) {
        throw new HttpError(errors.badRequest, { fields: { [`lines.${i}.itemId`]: 'not_found' } })
      }
    }
    await store.poInsert(tx, {
      id,
      projectId,
      partyId,
      code,
      amount: moneyOf(total),
      status: 'draft',
      note: input.note ?? null,
      createdBy: ctx.userId ?? null,
      now,
    })
    for (let i = 0; i < lines.length; i++) {
      const l = /** @type {any} */ (lines[i])
      await store.poLineInsert(tx, {
        id: randomUUID(),
        poId: id,
        lineNo: i + 1,
        itemId: l.itemId,
        qty: l.qty,
        price: l.price,
        amount: l.amount,
      })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'po_create',
      whoId: ctx.userId ?? null,
      refType: 'purchase_order',
      refId: id,
      before: null,
      after: { code, partyId, projectId, amount: moneyOf(total), lines },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getPo(ctx, id)
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ projectId?: string, partyId?: string, status?: string, keyword?: string }} filters
 */
export async function listPos(ctx, page, filters) {
  for (const k of /** @type {const} */ (['projectId', 'partyId'])) {
    if (filters[k] && !UUID.test(filters[k])) return { items: [], nextCursor: null }
  }
  const rows = await store.poList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(poToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getPo(ctx, id) {
  const row = await store.poById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const [lines, received] = await Promise.all([store.poLinesOf(ctx, id), store.receivedQtyByPo(ctx, id)])
  /** @type {Map<string, number>} */
  const got = new Map(received.map((r) => [String(r.po_line_id), centsOf(String(r.received))]))
  return {
    ...poToApi(row),
    lines: lines.map((l) => {
      const ordered = centsOf(l.qty)
      const done = got.get(String(l.id)) ?? 0
      return { ...poLineToApi(l), receivedQty: Number(moneyOf(done)), remainingQty: Number(moneyOf(ordered - done)) }
    }),
  }
}

/**
 * 采购单只有备注可改；金额随行，状态只能走审批/收货。
 * @param {any} ctx @param {string} id @param {{ note?: string, version?: number }} patch
 */
export async function updatePo(ctx, id, patch) {
  const cur = await store.poById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}），请刷新` })
  }
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.poUpdateNote(tx, {
      id,
      expectedVersion: cur.version,
      note: patch.note !== undefined ? patch.note : cur.note,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'po_update',
      whoId: ctx.userId ?? null,
      refType: 'purchase_order',
      refId: id,
      before: { note: cur.note, version: cur.version },
      after: { note: patch.note ?? cur.note },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getPo(ctx, id)
}

/**
 * 提交审批：状态与审批实例同一事务，绝不出现「单子 draft、审批在途」。
 * @param {any} ctx @param {string} id @param {{ version?: number }} input
 */
export async function submitPo(ctx, id, input) {
  const cur = await store.poById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (input.version !== undefined && input.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}），请刷新` })
  }
  assertTransition('采购单', PO_TRANSITIONS, cur.status, 'pending')

  await withTx(ctx, async (tx) => {
    const locked = await store.lockPo(tx, id)
    if (!locked) throw new HttpError(errors.notFound)
    assertTransition('采购单', PO_TRANSITIONS, locked.status, 'pending')
    await store.poSetStatus(tx, { id, from: locked.status, to: 'pending', now: new Date() })
    await approval.submit(tx, { docType: DOC_PO, docId: id, amount: moneyOf(centsOf(locked.amount)) })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'po_submit',
      whoId: ctx.userId ?? null,
      refType: 'purchase_order',
      refId: id,
      before: { status: locked.status },
      after: { status: 'pending', amount: locked.amount },
      traceId: ctx.requestId ?? '',
      at: new Date(),
    })
  })
  return getPo(ctx, id)
}

// ── 收货 ────────────────────────────────────────────────────────────────────
/**
 * 按 PO 行收货：超量 409、未审批 409，库存只经 stock.applyMove 记账。
 * @param {any} ctx
 * @param {{ poId: string, warehouseId: string, code?: string, note?: string, receivedAt?: unknown, lines: unknown }} input
 */
export async function createReceipt(ctx, input) {
  const poId = assertId(input.poId)
  const warehouseId = assertId(input.warehouseId)
  const rows = objectArray(input.lines, ['poLineId', 'qty', 'sns'], 'lines')

  /** @type {Map<string, { qtyCents: number, sns: string[] }>} */
  const grouped = new Map()
  rows.forEach((x, i) => {
    const poLineId = assertId(x.poLineId)
    const qty = positiveCents(x.qty, `lines.${i}.qty`)
    const cur = grouped.get(poLineId) ?? { qtyCents: 0, sns: [] }
    cur.qtyCents += qty
    if (x.sns !== undefined && x.sns !== null) {
      if (!Array.isArray(x.sns)) throw new HttpError(errors.badRequest, { fields: { [`lines.${i}.sns`]: 'array' } })
      for (const sn of x.sns) cur.sns.push(sn)
    }
    grouped.set(poLineId, cur)
  })

  const now = new Date()
  const receivedAt = dateOf(input.receivedAt, 'receivedAt') ?? now
  const id = randomUUID()
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.goodsReceipt)

  await withTx(ctx, async (tx) => {
    const po = await store.lockPo(tx, poId)
    if (!po) throw new HttpError(errors.notFound)
    if (po.status !== 'approved' && po.status !== 'closed') {
      throw new HttpError(errors.conflict, {
        reason: `采购单状态为 ${po.status}，审批通过才能收货`,
        allowed: ['approved', 'closed'],
      })
    }
    if (await store.receiptByCode(tx, code)) {
      throw new HttpError(errors.conflict, { reason: `收货单号 ${code} 已存在` })
    }

    // ① 先校验全部行（含超量），一行不合法整单不落库
    /** @type {{ line: any, qtyCents: number, amountCents: number, sns: string[] }[]} */
    const planned = []
    for (const [poLineId, g] of grouped) {
      const line = await store.lockPoLine(tx, poLineId)
      if (!line || line.po_id !== poId) {
        throw new HttpError(errors.badRequest, { fields: { lines: `PO 行 ${poLineId} 不属于该采购单` } })
      }
      const already = centsOf(await store.receivedQtyOf(tx, poLineId))
      const ordered = centsOf(line.qty)
      const remaining = ordered - already
      if (g.qtyCents > remaining) {
        throw new HttpError(errors.conflict, {
          reason: `PO 行 ${line.line_no} 超量收货：剩余 ${moneyOf(remaining)}，本次 ${moneyOf(g.qtyCents)}`,
          poLineId,
          ordered: moneyOf(ordered),
          received: moneyOf(already),
          remaining: moneyOf(remaining),
        })
      }
      planned.push({
        line,
        qtyCents: g.qtyCents,
        amountCents: mulCents(g.qtyCents, centsOf(line.price)),
        sns: g.sns,
      })
    }

    // ② 落收货单 + 行 + 库存流水 + 成本
    await store.receiptInsert(tx, {
      id,
      poId,
      warehouseId,
      code,
      status: 'posted',
      receivedAt,
      note: input.note ?? null,
      receivedBy: ctx.userId ?? null,
      now,
    })
    for (const p of planned) {
      const qty = moneyOf(p.qtyCents)
      const amount = moneyOf(p.amountCents)
      await store.grnLineInsert(tx, {
        id: randomUUID(),
        receiptId: id,
        poLineId: p.line.id,
        itemId: p.line.item_id,
        qty,
        price: p.line.price,
        amount,
      })
      await applyMove(tx, {
        warehouseId,
        itemId: p.line.item_id,
        qty,
        dir: 'in',
        moveType: 'purchase_in',
        refType: 'goods_receipt',
        refId: id,
        unitCost: p.line.price,
        note: `采购收货 ${code}`,
        sns: p.sns,
      })
      if (po.project_id) {
        await store.costInsert(tx, {
          id: randomUUID(),
          projectId: po.project_id,
          source: 'purchase',
          refType: 'goods_receipt',
          refId: id,
          amount,
          note: `采购单 ${po.code} 收货 ${code}`,
          at: receivedAt,
        })
      }
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'receipt_create',
      whoId: ctx.userId ?? null,
      refType: 'goods_receipt',
      refId: id,
      before: null,
      after: { code, poId, warehouseId, lines: planned.map((p) => ({ poLineId: p.line.id, qty: moneyOf(p.qtyCents) })) },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getReceipt(ctx, id)
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ poId?: string, warehouseId?: string }} filters
 */
export async function listReceipts(ctx, page, filters) {
  for (const k of /** @type {const} */ (['poId', 'warehouseId'])) {
    if (filters[k] && !UUID.test(filters[k])) return { items: [], nextCursor: null }
  }
  const rows = await store.receiptList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(receiptToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getReceipt(ctx, id) {
  const row = await store.receiptById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const lines = await store.grnLinesOf(ctx, id)
  return { ...receiptToApi(row), lines: lines.map(grnLineToApi) }
}

// ── 分包 + 进度款 ───────────────────────────────────────────────────────────
/**
 * @param {any} ctx
 * @param {{ projectId: string, partyId: string, code: string, name: string, amount: unknown, note?: string }} input
 */
export async function createSubcontract(ctx, input) {
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.subcontract)
  if (await store.subByCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `分包合同号 ${code} 已存在` })
  const projectId = assertId(input.projectId)
  if (!(await store.projectExists(ctx, projectId))) {
    throw new HttpError(errors.badRequest, { fields: { projectId: 'not_found' } })
  }
  const partyId = assertId(input.partyId)
  if (!(await store.partyExists(ctx, partyId))) {
    throw new HttpError(errors.badRequest, { fields: { partyId: 'not_found' } })
  }
  const amount = moneyOf(positiveCents(input.amount, 'amount'))
  const now = new Date()
  const id = randomUUID()
  await withTx(ctx, async (tx) => {
    await store.subInsert(tx, {
      id,
      projectId,
      partyId,
      code,
      name: input.name,
      amount,
      status: 'draft',
      note: input.note ?? null,
      now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'subcontract_create',
      whoId: ctx.userId ?? null,
      refType: 'subcontract',
      refId: id,
      before: null,
      after: { code, name: input.name, projectId, partyId, amount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getSubcontract(ctx, id)
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ projectId?: string, partyId?: string, status?: string }} filters
 */
export async function listSubcontracts(ctx, page, filters) {
  for (const k of /** @type {const} */ (['projectId', 'partyId'])) {
    if (filters[k] && !UUID.test(filters[k])) return { items: [], nextCursor: null }
  }
  const rows = await store.subList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(subToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getSubcontract(ctx, id) {
  const row = await store.subById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  const progress = await store.progressOf(ctx, id)
  const total = centsOf(String((await store.progressSum(ctx, id))?.total ?? 0))
  return {
    ...subToApi(row),
    progressAmount: Number(moneyOf(total)),
    remainingAmount: Number(moneyOf(centsOf(row.amount) - total)),
    progress: progress.map(progressToApi),
  }
}

/**
 * @param {any} ctx @param {string} id @param {{ version?: number }} input
 */
export async function submitSubcontract(ctx, id, input) {
  const cur = await store.subById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (input.version !== undefined && input.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${cur.version}），请刷新` })
  }
  assertTransition('分包合同', SUB_TRANSITIONS, cur.status, 'pending')
  await withTx(ctx, async (tx) => {
    const locked = await store.subById(tx, id)
    if (!locked) throw new HttpError(errors.notFound)
    assertTransition('分包合同', SUB_TRANSITIONS, locked.status, 'pending')
    const now = new Date()
    const n = await store.subSetStatus(tx, { id, from: locked.status, to: 'pending', now })
    if (!n) throw new HttpError(errors.conflict, { reason: '分包合同已被并发修改，请刷新' })
    await approval.submit(tx, { docType: DOC_SUB, docId: id, amount: moneyOf(centsOf(locked.amount)) })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'subcontract_submit',
      whoId: ctx.userId ?? null,
      refType: 'subcontract',
      refId: id,
      before: { status: locked.status },
      after: { status: 'pending', amount: locked.amount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getSubcontract(ctx, id)
}

/**
 * 进度款：只有已审批的分包合同才能报进度；累计不能超过合同额。
 * @param {any} ctx @param {string} id
 * @param {{ seq: number, amount: unknown, note?: string }} input
 */
export async function createProgress(ctx, id, input) {
  const sub = await store.subById(ctx, assertId(id))
  if (!sub) throw new HttpError(errors.notFound)
  if (sub.status !== 'approved' && sub.status !== 'closed') {
    throw new HttpError(errors.conflict, {
      reason: `分包合同状态为 ${sub.status}，审批通过后才能报进度款`,
      allowed: ['approved', 'closed'],
    })
  }
  const amtCents = positiveCents(input.amount, 'amount')
  const done = centsOf(String((await store.progressSum(ctx, id))?.total ?? 0))
  const total = done + amtCents
  const cap = centsOf(sub.amount)
  if (total > cap) {
    throw new HttpError(errors.conflict, {
      reason: `进度款累计超合同额：合同 ${moneyOf(cap)}，已报 ${moneyOf(done)}，本次 ${moneyOf(amtCents)}`,
      remaining: moneyOf(cap - done),
    })
  }
  const now = new Date()
  const pid = randomUUID()
  await withTx(ctx, async (tx) => {
    await store.progressInsert(tx, {
      id: pid,
      subcontractId: id,
      seq: input.seq,
      amount: moneyOf(amtCents),
      status: 'draft',
      note: input.note ?? null,
      now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'progress_create',
      whoId: ctx.userId ?? null,
      refType: 'subcontract_progress',
      refId: pid,
      before: null,
      after: { subcontractId: id, seq: input.seq, amount: moneyOf(amtCents) },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getProgress(ctx, pid)
}

/** @param {any} ctx @param {string} id */
export async function getProgress(ctx, id) {
  const row = await store.progressById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return progressToApi(row)
}

/**
 * @param {any} ctx @param {string} subcontractId @param {string} progressId @param {{ version?: number }} input
 */
export async function submitProgress(ctx, subcontractId, progressId, input) {
  const subId = assertId(subcontractId)
  const row = await store.progressById(ctx, assertId(progressId))
  if (!row || row.subcontract_id !== subId) throw new HttpError(errors.notFound)
  if (input.version !== undefined && input.version !== row.version) {
    throw new HttpError(errors.conflict, { reason: `版本已变（当前 ${row.version}），请刷新` })
  }
  assertTransition('进度款', PROGRESS_TRANSITIONS, row.status, 'pending')
  await withTx(ctx, async (tx) => {
    const cur = await store.progressById(tx, row.id)
    if (!cur) throw new HttpError(errors.notFound)
    assertTransition('进度款', PROGRESS_TRANSITIONS, cur.status, 'pending')
    const now = new Date()
    const n = await store.progressSetStatus(tx, { id: row.id, from: cur.status, to: 'pending', now })
    if (!n) throw new HttpError(errors.conflict, { reason: '进度款已被并发修改，请刷新' })
    await approval.submit(tx, {
      docType: DOC_PROGRESS,
      docId: row.id,
      amount: moneyOf(centsOf(cur.amount)),
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'progress_submit',
      whoId: ctx.userId ?? null,
      refType: 'subcontract_progress',
      refId: row.id,
      before: { status: cur.status },
      after: { status: 'pending', amount: cur.amount },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getProgress(ctx, row.id)
}

// ── 应收应付 + 开票 + 收付款 ────────────────────────────────────────────────
/**
 * 合同 → 应收登记。amount 省略时取合同额。
 * @param {any} ctx
 * @param {{ contractId: string, amount?: unknown, note?: string }} input
 */
export async function createReceivable(ctx, input) {
  const contractId = assertId(input.contractId)
  const contract = await store.contractById(ctx, contractId)
  if (!contract) throw new HttpError(errors.notFound)
  const amtCents = input.amount === undefined || input.amount === null ? centsOf(contract.amount) : positiveCents(input.amount, 'amount')
  if (amtCents <= 0) throw new HttpError(errors.badRequest, { fields: { amount: 'positive' } })
  const now = new Date()
  const id = randomUUID()
  await withTx(ctx, async (tx) => {
    await store.arInsert(tx, {
      id,
      partyId: contract.party_id,
      projectId: contract.project_id,
      contractId,
      invoiceId: null,
      entryType: 'contract',
      amount: moneyOf(amtCents),
      refType: 'contract',
      refId: contractId,
      note: input.note ?? null,
      at: now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'ar_create',
      whoId: ctx.userId ?? null,
      refType: 'ar_ledger',
      refId: id,
      before: null,
      after: { contractId, amount: moneyOf(amtCents) },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  const row = await store.arById(ctx, id)
  return arToApi(row ?? { id })
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ partyId?: string, projectId?: string, contractId?: string }} filters
 */
export async function listReceivables(ctx, page, filters) {
  if (filters.partyId && !UUID.test(filters.partyId)) return { items: [], nextCursor: null }
  if (filters.projectId && !UUID.test(filters.projectId)) return { items: [], nextCursor: null }
  const rows = await store.arList(ctx, { ...page, ...filters })
  // ar_ledger 的排序键是 at；trimPage 认 created_at
  const { items, nextCursor } = trimPage(rows.map((r) => ({ ...r, created_at: r.at })), page.limit)
  return { items: items.map(arToApi), nextCursor }
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ partyId?: string, projectId?: string, poId?: string, subcontractId?: string }} filters
 */
export async function listPayables(ctx, page, filters) {
  for (const k of /** @type {const} */ (['partyId', 'projectId', 'poId', 'subcontractId'])) {
    if (filters[k] && !UUID.test(filters[k])) return { items: [], nextCursor: null }
  }
  const rows = await store.apList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows.map((r) => ({ ...r, created_at: r.at })), page.limit)
  return { items: items.map(apToApi), nextCursor }
}

/**
 * 台账余额（正数=未收/未付）。收款/付款前也用它做超额校验。
 * @param {any} ctx @param {'ar'|'ap'} kind
 * @param {{ partyId?: string, projectId?: string }} filters
 */
export async function balance(ctx, kind, filters) {
  if (filters.partyId && !UUID.test(filters.partyId)) throw new HttpError(errors.notFound)
  if (filters.projectId && !UUID.test(filters.projectId)) throw new HttpError(errors.notFound)
  const v = await store.ledgerBalance(ctx, kind, filters)
  return { kind, balance: Number(moneyOf(centsOf(v))) }
}

/**
 * 开票：ar 票进应收台账，ap 票进应付台账（与合同/PO/分包挂钩）。
 * @param {any} ctx
 * @param {{ kind: string, partyId: string, code: string, amount: unknown, projectId?: string, contractId?: string, poId?: string, subcontractId?: string, issuedAt?: unknown, note?: string }} input
 */
export async function createInvoice(ctx, input) {
  const kind = input.kind
  if (!INVOICE_KINDS.includes(kind)) {
    throw new HttpError(errors.badRequest, { fields: { kind: `enum:${INVOICE_KINDS.join('|')}` } })
  }
  const code = input.code ? normCode(input.code) : await nextCode(ctx, PREFIX.invoice)
  if (await store.invoiceByCode(ctx, code)) throw new HttpError(errors.conflict, { reason: `发票号 ${code} 已存在` })
  const partyId = assertId(input.partyId)
  if (!(await store.partyExists(ctx, partyId))) {
    throw new HttpError(errors.badRequest, { fields: { partyId: 'not_found' } })
  }
  const amount = moneyOf(positiveCents(input.amount, 'amount'))

  const projectId = input.projectId ? assertId(input.projectId) : null
  if (projectId && !(await store.projectExists(ctx, projectId))) {
    throw new HttpError(errors.badRequest, { fields: { projectId: 'not_found' } })
  }
  const contractId = input.contractId ? assertId(input.contractId) : null
  if (contractId && !(await store.contractById(ctx, contractId))) {
    throw new HttpError(errors.badRequest, { fields: { contractId: 'not_found' } })
  }
  const poId = input.poId ? assertId(input.poId) : null
  if (poId && !(await store.poById(ctx, poId))) {
    throw new HttpError(errors.badRequest, { fields: { poId: 'not_found' } })
  }
  const subcontractId = input.subcontractId ? assertId(input.subcontractId) : null
  if (subcontractId && !(await store.subById(ctx, subcontractId))) {
    throw new HttpError(errors.badRequest, { fields: { subcontractId: 'not_found' } })
  }
  if (kind === 'ar' && !contractId && !projectId) {
    throw new HttpError(errors.badRequest, { reason: '销项发票至少要关联合同或项目' })
  }
  if (kind === 'ap' && !poId && !subcontractId) {
    throw new HttpError(errors.badRequest, { reason: '进项发票至少要关联采购单或分包合同' })
  }

  const now = new Date()
  const issuedAt = dateOf(input.issuedAt, 'issuedAt') ?? now
  const id = randomUUID()
  await withTx(ctx, async (tx) => {
    await store.invoiceInsert(tx, {
      id,
      kind,
      partyId,
      projectId,
      contractId,
      poId,
      subcontractId,
      code,
      amount,
      status: 'issued',
      issuedAt,
      note: input.note ?? null,
      now,
    })
    if (kind === 'ar') {
      await store.arInsert(tx, {
        id: randomUUID(),
        partyId,
        projectId,
        contractId,
        invoiceId: id,
        entryType: 'invoice',
        amount,
        refType: 'invoice',
        refId: id,
        note: `销项发票 ${code}`,
        at: issuedAt,
      })
    } else {
      await store.apInsert(tx, {
        id: randomUUID(),
        partyId,
        projectId,
        poId,
        subcontractId,
        invoiceId: id,
        entryType: 'invoice',
        amount,
        refType: 'invoice',
        refId: id,
        note: `进项发票 ${code}`,
        at: issuedAt,
      })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'invoice_create',
      whoId: ctx.userId ?? null,
      refType: 'invoice',
      refId: id,
      before: null,
      after: { kind, code, partyId, amount, projectId, contractId, poId, subcontractId },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getInvoice(ctx, id)
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ kind?: string, projectId?: string, partyId?: string, status?: string }} filters
 */
export async function listInvoices(ctx, page, filters) {
  for (const k of /** @type {const} */ (['projectId', 'partyId'])) {
    if (filters[k] && !UUID.test(filters[k])) return { items: [], nextCursor: null }
  }
  const rows = await store.invoiceList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(invoiceToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getInvoice(ctx, id) {
  const row = await store.invoiceById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return invoiceToApi(row)
}

/**
 * 收付款核销：先看台账未结余额，超额 409；付款写一条负数台账，余额自然减少。
 * @param {any} ctx
 * @param {{ kind: string, partyId: string, amount: unknown, projectId?: string, method?: string, paidAt?: unknown, note?: string }} input
 */
export async function createPayment(ctx, input) {
  const kind = input.kind
  if (!PAYMENT_KINDS.includes(kind)) {
    throw new HttpError(errors.badRequest, { fields: { kind: `enum:${PAYMENT_KINDS.join('|')}` } })
  }
  const partyId = assertId(input.partyId)
  const amtCents = positiveCents(input.amount, 'amount')
  const amount = moneyOf(amtCents)
  const projectId = input.projectId ? assertId(input.projectId) : null
  const method = input.method ?? 'bank'
  if (!PAYMENT_METHODS.includes(method)) {
    throw new HttpError(errors.badRequest, { fields: { method: `enum:${PAYMENT_METHODS.join('|')}` } })
  }
  const paidAt = dateOf(input.paidAt, 'paidAt') ?? new Date()
  const now = new Date()
  const id = randomUUID()

  await withTx(ctx, async (tx) => {
    if (!(await store.partyExists(tx, partyId))) {
      throw new HttpError(errors.badRequest, { fields: { partyId: 'not_found' } })
    }
    if (projectId && !(await store.projectExists(tx, projectId))) {
      throw new HttpError(errors.badRequest, { fields: { projectId: 'not_found' } })
    }
    const outstanding = centsOf(
      await store.ledgerBalance(tx, /** @type {'ar'|'ap'} */ (kind), { partyId, ...(projectId ? { projectId } : {}) }),
    )
    if (amtCents > outstanding) {
      throw new HttpError(errors.conflict, {
        reason: `${kind === 'ar' ? '收款' : '付款'}核销超过未结余额：未结 ${moneyOf(outstanding)}，本次 ${amount}`,
        outstanding: moneyOf(outstanding),
      })
    }
    await store.paymentInsert(tx, {
      id,
      kind,
      partyId,
      projectId,
      amount,
      method,
      paidAt,
      note: input.note ?? null,
      createdBy: ctx.userId ?? null,
      now,
    })
    const neg = moneyOf(-amtCents)
    if (kind === 'ar') {
      await store.arInsert(tx, {
        id: randomUUID(),
        partyId,
        projectId,
        contractId: null,
        invoiceId: null,
        entryType: 'receipt',
        amount: neg,
        refType: 'payment',
        refId: id,
        note: input.note ?? null,
        at: paidAt,
      })
    } else {
      await store.apInsert(tx, {
        id: randomUUID(),
        partyId,
        projectId,
        poId: null,
        subcontractId: null,
        invoiceId: null,
        entryType: 'payment',
        amount: neg,
        refType: 'payment',
        refId: id,
        note: input.note ?? null,
        at: paidAt,
      })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'purchase',
      action: 'payment_create',
      whoId: ctx.userId ?? null,
      refType: 'payment',
      refId: id,
      before: null,
      after: { kind, partyId, projectId, amount, method, outstanding: moneyOf(outstanding) },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getPayment(ctx, id)
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ kind?: string, partyId?: string, projectId?: string }} filters
 */
export async function listPayments(ctx, page, filters) {
  for (const k of /** @type {const} */ (['partyId', 'projectId'])) {
    if (filters[k] && !UUID.test(filters[k])) return { items: [], nextCursor: null }
  }
  const rows = await store.paymentList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(paymentToApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getPayment(ctx, id) {
  const row = await store.paymentById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return paymentToApi(row)
}

// ── 成本与项目毛利（M4 唯一验收点） ─────────────────────────────────────────
/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ projectId?: string, source?: string }} filters
 */
export async function listCosts(ctx, page, filters) {
  if (filters.projectId && !UUID.test(filters.projectId)) return { items: [], nextCursor: null }
  const rows = await store.costList(ctx, { ...page, ...filters })
  const { items, nextCursor } = trimPage(rows.map((r) => ({ ...r, created_at: r.at })), page.limit)
  return { items: items.map(costToApi), nextCursor }
}

/**
 * 项目毛利：revenue = 合同额合计，cost = cost_line 合计，全部按「分」整数算。
 * 例：合同 100 万、采购 60 万、分包 10 万 → gross=300000，grossRate=0.3（一分不差）。
 * @param {any} ctx @param {string} projectId
 * @returns {Promise<{ revenue: number, cost: number, gross: number, grossRate: number | null }>}
 */
export async function projectProfit(ctx, projectId) {
  const id = assertId(projectId)
  if (!(await store.projectExists(ctx, id))) throw new HttpError(errors.notFound)
  const [revRow, costRow] = await Promise.all([store.contractAmountOf(ctx, id), store.costSum(ctx, id)])
  const revenueCents = centsOf(String(revRow?.total ?? 0))
  const costCents = centsOf(String(costRow?.total ?? 0))
  const grossCents = revenueCents - costCents
  return {
    revenue: Number(moneyOf(revenueCents)),
    cost: Number(moneyOf(costCents)),
    gross: Number(moneyOf(grossCents)),
    // 保留 6 位小数，避免 1/3 这类比率出现长尾浮点；3e7/1e8 仍是精确的 0.3
    grossRate: revenueCents === 0 ? null : Math.round((grossCents / revenueCents) * 1e6) / 1e6,
  }
}
