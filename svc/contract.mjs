import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import { normCode } from '../http/validate.mjs'
import { assertTransition, allowedNext } from './transition.mjs'
import { PROJECT_TRANSITIONS } from './project.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/contract.mjs'

/** 合同状态机（M1-DESIGN §2）：只有 draft → signed，签约即终态 */
export const TRANSITIONS = /** @type {const} */ ({ draft: ['signed'], signed: [] })
export const CONTRACT_STATUSES = Object.keys(TRANSITIONS)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 */
function assertId(/** @type {string} */ id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** money 在 PG/MySQL 两个驱动里都是字符串，对外统一成数字 */
const num = (/** @type {unknown} */ v) => (v === null || v === undefined ? null : Number(v))

/** @param {any} r */
export const toApi = (r) => ({
  id: r.id,
  projectId: r.project_id,
  quotationId: r.quotation_id,
  code: r.code,
  name: r.name,
  partyId: r.party_id,
  amount: num(r.amount),
  signAt: r.sign_at,
  status: r.status,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(TRANSITIONS, r.status),
})

/** @param {any} r */
const lineToApi = (r) => ({
  id: r.id,
  lineNo: r.line_no,
  itemName: r.item_name,
  spec: r.spec,
  uom: r.uom,
  qty: num(r.qty),
  price: num(r.price),
  amount: num(r.amount),
})

/** @param {any} r */
const termToApi = (r) => ({ id: r.id, seq: r.seq, title: r.title, content: r.content })

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null }} page
 * @param {{ projectId?: string, status?: string }} filters
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
  const [lines, terms] = await Promise.all([store.linesOf(ctx, id), store.termsOf(ctx, id)])
  return { ...toApi(row), lines: lines.map(lineToApi), terms: terms.map(termToApi) }
}

/**
 * 从报价快照生成合同：行从 quotation_line 原样拷（名称/规格/数量/单价/金额），
 * 客户与金额继承报价，源单之后改版不影响已生成合同。
 * @param {any} ctx
 * @param {{ quotationId: string, code: string, name: string, signAt?: Date, note?: string, terms: { seq: number, title: string, content: string }[] }} input
 */
export async function createContract(ctx, input) {
  const quotationId = assertId(input.quotationId)
  const quotation = await store.quotationById(ctx, quotationId)
  if (!quotation) throw new HttpError(errors.notFound)
  if (quotation.status !== 'accepted') {
    throw new HttpError(errors.conflict, {
      reason: `报价 ${quotation.code} 状态为 ${quotation.status}，未被接受不能签合同`,
      allowed: ['accepted'],
    })
  }
  const code = normCode(input.code)
  if (await store.byCode(ctx, code)) {
    throw new HttpError(errors.conflict, { reason: `合同编号 ${code} 已存在` })
  }

  const lines = await store.quotationLinesOf(ctx, quotationId)
  const now = new Date()
  const id = randomUUID()
  const row = {
    id,
    projectId: quotation.project_id,
    quotationId,
    code,
    name: input.name,
    partyId: quotation.party_id,
    amount: quotation.amount,
    signAt: input.signAt ?? null,
    status: 'draft',
    note: input.note ?? null,
    now,
  }

  await withTx(ctx, async (tx) => {
    await store.insert(tx, row)
    for (const l of lines) {
      await store.insertLine(tx, {
        id: randomUUID(),
        contractId: id,
        lineNo: l.line_no,
        itemName: l.item_name,
        spec: l.spec,
        uom: l.uom,
        qty: l.qty,
        price: l.price,
        amount: l.amount,
      })
    }
    for (const t of input.terms) {
      await store.insertTerm(tx, { id: randomUUID(), contractId: id, seq: t.seq, title: t.title, content: t.content })
    }
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'contract',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'contract',
      refId: id,
      before: null,
      after: { code: row.code, name: row.name, amount: num(row.amount), quotationId, lines: lines.length },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getContract(ctx, id)
}

/**
 * 状态推进。draft→signed：同事务写 sign_at + 把 project 推到 signed + 补一条 project_stage_log。
 * @param {any} ctx
 * @param {string} id
 * @param {string} to
 */
export async function advanceContract(ctx, id, to) {
  const cur = await store.byId(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  assertTransition('contract', TRANSITIONS, cur.status, to)

  // 建合同时已给 signAt 就沿用，否则以推进时刻为签署时间
  const signAt = cur.sign_at ? new Date(cur.sign_at) : new Date()
  const now = new Date()

  await withTx(ctx, async (tx) => {
    const project = await store.projectById(tx, cur.project_id)
    if (!project) throw new HttpError(errors.notFound)

    const n = await store.markSigned(tx, { id, from: cur.status, to, signAt, now })
    if (!n) {
      const fresh = await store.byId(tx, id)
      throw new HttpError(errors.conflict, {
        reason: `合同已是 ${fresh?.status ?? '未知'}，并发修改请重试`,
        allowed: allowedNext(TRANSITIONS, fresh?.status ?? cur.status),
      })
    }

    if (to === 'signed' && project.status === 'signed') {
      // 同一项目的第二份合同（增补/换版）：项目已是终态，联动幂等跳过，不重复写历史
    } else if (to === 'signed') {
      // 项目侧也必须走自己的状态机：项目不在「报价中」就直接签约 = 跳级，拒绝，
      // 否则项目历史里会凭空多出一条 designing→signed（M1 的验收要求正是“不可跳级”）。
      assertTransition('project', PROJECT_TRANSITIONS, project.status, 'signed')
      const p = await store.markProjectSigned(tx, {
        projectId: cur.project_id,
        from: project.status,
        amount: cur.amount,
        now,
      })
      if (!p) {
        throw new HttpError(errors.conflict, {
          reason: '项目状态已被他人推进，请刷新',
          allowed: allowedNext(PROJECT_TRANSITIONS, project.status),
        })
      }
      await store.insertStageLog(tx, {
        id: randomUUID(),
        projectId: cur.project_id,
        fromStatus: project.status,
        toStatus: 'signed',
        actorId: ctx.userId ?? null,
        note: '合同签署',
        at: now,
      })
    }

    await audit.insert(tx, {
      id: randomUUID(),
      module: 'contract',
      action: 'advance',
      whoId: ctx.userId ?? null,
      refType: 'contract',
      refId: id,
      before: { status: cur.status, signAt: cur.sign_at },
      after: { status: to, signAt, projectStatus: to === 'signed' ? 'signed' : project.status },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return getContract(ctx, id)
}
