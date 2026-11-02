import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { close, connect, exec, one } from '../db/index.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { makeApp, jsonOf } from './helpers.mjs'

/**
 * M4 采购 + 财务。重点：
 *  - PO 金额只由行合计得出，按「分」整数算（1.005 边界）
 *  - 审批通过才能收货；超量 409 且库存不变；收货走 stock.applyMove（有 stock_move）
 *  - 分包进度款审批通过 → cost_line
 *  - 收款核销 → ar_ledger 余额下降；超额 409
 *  - 项目毛利 = 合同额 - cost_line 合计，一分不差（M4 唯一验收点）
 */

const password = 'test-pass-123'
const run = randomUUID().slice(0, 8).toUpperCase()
const slugA = `pa${run.toLowerCase()}`
const slugB = `pb${run.toLowerCase()}`
const emailA = `pa-${run}@example.com`
const emailB = `pb-${run}@example.com`

/** @type {any} */
let app
let dbUp = false
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''
/** @type {string} */
let tenantAId = ''
/** @type {string} */
let ownerAId = ''
/** @type {string} */
let partyAId = ''
/** @type {string} */
let partyBId = ''
/** @type {string} */
let itemAId = ''
/** @type {string} */
let itemBId = ''
/** @type {string} */
let whAId = ''

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  await exec({}, 'DELETE FROM login_attempt', [])
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲采购', email: emailA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙采购', email: emailB, password })
  app = await makeApp()
  cookieA = await app.login(emailA, password)
  cookieB = await app.login(emailB, password)

  const meA = await jsonOf(await get('/api/me', slugA, cookieA))
  tenantAId = meA.tenant.id
  ownerAId = meA.user.id
  const meB = await jsonOf(await get('/api/me', slugB, cookieB))
  partyBId = await createParty(cookieB, slugB, `PB${run}`)
  assert.ok(meB.user.id)

  partyAId = await createParty(cookieA, slugA, `PA${run}`)
  itemAId = await createItem(cookieA, slugA, `IT${run}`)
  itemBId = await createItem(cookieA, slugA, `IT${run}B`)
  whAId = await createWarehouse(cookieA, slugA, `WH${run}`)

  // 审批链：采购单按金额两档（10 万以下 1 级 / 10 万及以上 2 级），分包与进度款各 1 级
  await createFlow(cookieA, slugA, `PO-LOW-${run}`, 'purchase_order', [
    { no: 1, approver_type: 'user', approver_ref: ownerAId, mode: 'any', max_amount: '100000.00' },
  ])
  await createFlow(cookieA, slugA, `PO-HIGH-${run}`, 'purchase_order', [
    { no: 1, approver_type: 'user', approver_ref: ownerAId, mode: 'any', min_amount: '100000.00' },
    { no: 2, approver_type: 'user', approver_ref: ownerAId, mode: 'any', min_amount: '100000.00' },
  ])
  await createFlow(cookieA, slugA, `SUB-${run}`, 'subcontract', [
    { no: 1, approver_type: 'user', approver_ref: ownerAId, mode: 'any' },
  ])
  await createFlow(cookieA, slugA, `PROG-${run}`, 'subcontract_progress', [
    { no: 1, approver_type: 'user', approver_ref: ownerAId, mode: 'any' },
  ])
})

test.after(async () => {
  await app?.close()
  await close()
})

// ── helpers ─────────────────────────────────────────────────────────────────
/** @param {string} path @param {string} slug @param {string} [cookie] */
const get = (path, slug, cookie = cookieA) => app.call('GET', `/t/${slug}${path}`, undefined, cookie)
/** @param {string} path @param {unknown} body @param {string} [slug] @param {string} [cookie] */
const post = (path, body, slug = slugA, cookie = cookieA) => app.call('POST', `/t/${slug}${path}`, body, cookie)
/** @param {string} path @param {unknown} body @param {string} [slug] @param {string} [cookie] */
const patch = (path, body, slug = slugA, cookie = cookieA) => app.call('PATCH', `/t/${slug}${path}`, body, cookie)

/** 断言状态码并返回 body（body 只能读一次，先断言再解析会炸）
 * @param {Response} res @param {number} status */
async function jsonAt(res, status) {
  const body = await jsonOf(res)
  assert.equal(res.status, status, JSON.stringify(body))
  return body
}

/** @param {string} cookie @param {string} slug @param {string} code */
async function createParty(cookie, slug, code) {
  const res = await post('/api/parties', { code, name: `供应商 ${code}`, partyType: 'supplier' }, slug, cookie)
  return (await jsonAt(res, 201)).id
}

/** @param {string} cookie @param {string} slug @param {string} code */
async function createItem(cookie, slug, code) {
  const res = await post('/api/items', { code, name: `物料 ${code}`, baseUom: 'PCS' }, slug, cookie)
  return (await jsonAt(res, 201)).id
}

/** @param {string} cookie @param {string} slug @param {string} code */
async function createWarehouse(cookie, slug, code) {
  const res = await post('/api/warehouses', { code, name: `仓库 ${code}` }, slug, cookie)
  return (await jsonAt(res, 201)).id
}

/**
 * @param {string} cookie @param {string} slug @param {string} code @param {string} docType
 * @param {any[]} steps
 */
async function createFlow(cookie, slug, code, docType, steps) {
  const res = await post('/api/approval/flows', { code, name: code, docType, steps }, slug, cookie)
  await jsonAt(res, 201)
}

/** @param {string} slug @param {string} code */
const newPoBody = (slug, code) => ({
  projectId: null,
  partyId: partyAId,
  code,
  lines: [{ itemId: itemAId, qty: '10', price: '100.00' }],
})

/** 逐级批准某个单据（当前实现里审批人都是 owner 自己）
 * @param {string} slug @param {string} docId */
async function approveDoc(slug, docId) {
  for (let i = 0; i < 5; i++) {
    const tasks = (await jsonOf(await get('/api/approvals/my-tasks', slug))).items.filter(
      (/** @type {any} */ t) => t.docId === docId && t.status === 'pending',
    )
    if (!tasks.length) return i
    for (const t of tasks) {
      const res = await post(`/api/approvals/tasks/${t.id}/decide`, { action: 'approve' }, slug)
      await jsonAt(res, 200)
    }
  }
  throw new Error('审批层级超过 5 级，测试假设不成立')
}

/** @param {string} projectId */
const profitOf = async (projectId, cookie = cookieA, slug = slugA) =>
  jsonOf(await get(`/api/projects/${projectId}/profit`, slug, cookie))

/** @param {string} itemId */
const stockOf = async (itemId) =>
  (await jsonOf(await get(`/api/stock/balances?warehouseId=${whAId}&itemId=${itemId}`, slugA))).items[0]?.qty ?? 0

/** 直插项目（M1 的项目只能由商机转立项，测试用最少的 SQL 造一个项目维度） */
/** @param {string} code */
async function insertProject(code) {
  const id = randomUUID()
  const now = new Date()
  await exec(
    {},
    `INSERT INTO project (tenant_id, id, code, name, party_id, opportunity_id, status, contract_amt, pm_user_id, start_date, end_date, note, created_at, updated_at, version)
     VALUES ($1, $2, $3, $4, $5, NULL, 'signed', 0.00, NULL, NULL, NULL, NULL, $6, $6, 1)`,
    [tenantAId, id, code, `项目 ${code}`, partyAId, now],
  )
  return id
}

/** 直插合同（合同切片要求报价 accepted，这里只验毛利口径，不重复跑 M1 主链） */
/** @param {string} projectId @param {string} amount */
async function insertContract(projectId, amount) {
  const id = randomUUID()
  const now = new Date()
  await exec(
    {},
    `INSERT INTO contract (tenant_id, id, project_id, quotation_id, code, name, party_id, amount, sign_at, status, note, created_at, updated_at)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, 'signed', NULL, $8, $8)`,
    [tenantAId, id, projectId, `C-${randomUUID().slice(0, 8)}`, '测试合同', partyAId, amount, now],
  )
  return id
}

// ── 1. 建单金额 = 行合计（分算法） ──────────────────────────────────────────
test('PO 金额由行合计得出，按分整数算（1.005 边界）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const code = `PO-CENTS-${run}`
  const res = await post('/api/purchase-orders', {
    partyId: partyAId,
    code,
    lines: [
      // 3 × 1.005：price 先按分四舍五入成 1.01，行金额 3.03（不是 toFixed 的 3.01/3.02）
      { itemId: itemAId, qty: '3', price: '1.005' },
      // 1.005 × 2.00：qty 按分四舍五入成 1.01，行金额 2.02
      { itemId: itemAId, qty: '1.005', price: '2.00' },
    ],
  })
  const po = await jsonAt(res, 201)
  assert.equal(po.status, 'draft')
  assert.equal(po.amount, 5.05)
  assert.equal(po.lines.length, 2)
  assert.equal(po.lines[0].amount, 3.03)
  assert.equal(po.lines[1].amount, 2.02)
  assert.equal(po.lines[0].lineNo, 1)
  assert.equal(po.lines[1].lineNo, 2)
  assert.deepEqual(po.allowed, ['pending'])

  // 客户端不能自己塞 amount / tenantId
  const bad = await post('/api/purchase-orders', { partyId: partyAId, code: `${code}-X`, amount: 1, lines: [] })
  assert.equal(bad.status, 400)
  const badLine = await post('/api/purchase-orders', {
    partyId: partyAId,
    code: `${code}-Y`,
    lines: [{ itemId: itemAId, qty: '1', price: '1', amount: '1' }],
  })
  assert.equal(badLine.status, 400)
  const dup = await post('/api/purchase-orders', { partyId: partyAId, code, lines: [{ itemId: itemAId, qty: '1', price: '1' }] })
  assert.equal(dup.status, 409)
})

// ── 2. 审批门禁 + 金额档 + 收货入库 ─────────────────────────────────────────
test('未审批不能收货；审批通过后收货入库并留 stock_move（10 万以上走 2 级）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const code = `PO-GATE-${run}`
  // 150000 ≥ 10 万 → 命中 2 级审批链
  const created = await jsonOf(
    await post('/api/purchase-orders', {
      partyId: partyAId,
      code,
      lines: [{ itemId: itemAId, qty: '10', price: '15000.00' }],
    }),
  )
  assert.equal(created.amount, 150000)

  // 未提交 → 409，库存不变
  const before = await stockOf(itemAId)
  const early = await post('/api/goods-receipts', {
    poId: created.id,
    warehouseId: whAId,
    lines: [{ poLineId: created.lines[0].id, qty: '1' }],
  })
  assert.equal(early.status, 409)
  assert.equal(await stockOf(itemAId), before)

  // 提交 → 金额档选中 2 级
  const submitted = await jsonOf(await post(`/api/purchase-orders/${created.id}/submit`, { version: created.version }))
  assert.equal(submitted.status, 'pending')
  const inst = await one({}, 'SELECT flow_snapshot, status FROM approval_instance WHERE doc_id = $1', [created.id])
  assert.equal(inst.status, 'pending')
  const snap = typeof inst.flow_snapshot === 'string' ? JSON.parse(inst.flow_snapshot) : inst.flow_snapshot
  assert.equal(snap.steps.length, 2)

  // 只批一级仍然不能收货
  const tasks1 = (await jsonOf(await get('/api/approvals/my-tasks', slugA))).items.filter(
    (/** @type {any} */ x) => x.docId === created.id,
  )
  assert.equal(tasks1.length, 1)
  assert.equal((await post(`/api/approvals/tasks/${tasks1[0].id}/decide`, { action: 'approve' }, slugA)).status, 200)
  const half = await post('/api/goods-receipts', {
    poId: created.id,
    warehouseId: whAId,
    lines: [{ poLineId: created.lines[0].id, qty: '1' }],
  })
  assert.equal(half.status, 409)

  // 批完第二级 → approved
  assert.equal(await approveDoc(slugA, created.id), 1)
  const poApproved = await jsonOf(await get(`/api/purchase-orders/${created.id}`, slugA))
  assert.equal(poApproved.status, 'approved')
  assert.deepEqual(poApproved.allowed, ['closed'])

  // 收货 → 库存 +10、movement 一条、成本 15 万进应付
  const rc = await post('/api/goods-receipts', {
    poId: created.id,
    warehouseId: whAId,
    code: `GRN-${run}`,
    lines: [{ poLineId: created.lines[0].id, qty: '10' }],
  })
  const receipt = await jsonAt(rc, 201)
  assert.equal(receipt.lines.length, 1)
  assert.equal(receipt.lines[0].amount, 150000)
  assert.equal(await stockOf(itemAId), 10)

  const moves = (await jsonOf(
    await get(`/api/stock/moves?refType=goods_receipt&refId=${receipt.id}`, slugA),
  )).items
  assert.equal(moves.length, 1)
  assert.equal(moves[0].dir, 'in')
  assert.equal(Number(moves[0].qty), 10)
  assert.equal(moves[0].moveType, 'purchase_in')

  // 应付台账：PO 审批通过时入账 15 万
  const bal = await jsonOf(await get(`/api/ap-ledger/balance?partyId=${partyAId}`, slugA))
  assert.ok(bal.balance >= 150000)
})

// ── 3. 超量收货 → 409 且库存不变 ────────────────────────────────────────────
test('超量收货 409，已收数量与库存都不变', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const created = await jsonOf(
    await post('/api/purchase-orders', {
      partyId: partyAId,
      code: `PO-OVER-${run}`,
      lines: [{ itemId: itemBId, qty: '10', price: '100.00' }],
    }),
  )
  await post(`/api/purchase-orders/${created.id}/submit`, {})
  await approveDoc(slugA, created.id)

  const first = await post('/api/goods-receipts', {
    poId: created.id,
    warehouseId: whAId,
    lines: [{ poLineId: created.lines[0].id, qty: '4' }],
  })
  await jsonAt(first, 201)
  assert.equal(await stockOf(itemBId), 4)

  const over = await post('/api/goods-receipts', {
    poId: created.id,
    warehouseId: whAId,
    lines: [{ poLineId: created.lines[0].id, qty: '7' }],
  })
  assert.equal(over.status, 409)
  const detail = await jsonOf(over)
  assert.equal(detail.error.details.remaining, '6.00')
  assert.equal(await stockOf(itemBId), 4)

  // PO 上剩余量也对（4 已收，6 未收）
  const po = await jsonOf(await get(`/api/purchase-orders/${created.id}`, slugA))
  assert.equal(po.lines[0].receivedQty, 4)
  assert.equal(po.lines[0].remainingQty, 6)
})

// ── 4. 分包进度款审批通过 → cost_line ───────────────────────────────────────
test('分包进度款审批通过后计入 cost_line（并生成应付）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await insertProject(`PSUB-${run}`)
  const sub = await jsonOf(
    await post('/api/subcontracts', {
      projectId,
      partyId: partyAId,
      code: `SUB-${run}`,
      name: '弱电分包',
      amount: '100000.00',
    }),
  )
  assert.equal(sub.status, 'draft')

  // 未审批的分包不能报进度款
  const early = await post(`/api/subcontracts/${sub.id}/progress`, { seq: 1, amount: '100000.00' })
  assert.equal(early.status, 409)

  await post(`/api/subcontracts/${sub.id}/submit`, { version: sub.version })
  await approveDoc(slugA, sub.id)
  const subApproved = await jsonOf(await get(`/api/subcontracts/${sub.id}`, slugA))
  assert.equal(subApproved.status, 'approved')

  const prog = await post(`/api/subcontracts/${sub.id}/progress`, { seq: 1, amount: '100000.00' })
  const progress = await jsonAt(prog, 201)
  assert.equal(progress.status, 'draft')

  const costsBefore = (await jsonOf(await get(`/api/cost-lines?projectId=${projectId}`, slugA))).items
  assert.equal(costsBefore.length, 0)

  await post(`/api/subcontracts/${sub.id}/progress/${progress.id}/submit`, { version: progress.version })
  await approveDoc(slugA, progress.id)

  const costs = (await jsonOf(await get(`/api/cost-lines?projectId=${projectId}`, slugA))).items
  assert.equal(costs.length, 1)
  assert.equal(costs[0].source, 'subcontract')
  assert.equal(costs[0].refType, 'subcontract_progress')
  assert.equal(costs[0].refId, progress.id)
  assert.equal(costs[0].amount, 100000)

  const progressAfter = await jsonOf(await get(`/api/subcontracts/${sub.id}/progress/${progress.id}`, slugA))
  assert.equal(progressAfter.status, 'approved')

  // 累计超合同额 → 409
  const over = await post(`/api/subcontracts/${sub.id}/progress`, { seq: 2, amount: '0.01' })
  assert.equal(over.status, 409)
})

// ── 5. 应收 + 收款核销 ──────────────────────────────────────────────────────
test('合同登记应收 → 收款核销使余额减少；超额核销 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await insertProject(`PAR-${run}`)
  const contractId = await insertContract(projectId, '1000000.00')

  const ar = await post('/api/ar-ledger', { contractId })
  const entry = await jsonAt(ar, 201)
  assert.equal(entry.entryType, 'contract')
  assert.equal(entry.amount, 1000000)

  let bal = await jsonOf(await get(`/api/ar-ledger/balance?partyId=${partyAId}&projectId=${projectId}`, slugA))
  assert.equal(bal.balance, 1000000)

  const pay = await post('/api/payments', { kind: 'ar', partyId: partyAId, projectId, amount: '300000.00', method: 'bank' })
  const payment = await jsonAt(pay, 201)
  assert.equal(payment.amount, 300000)

  bal = await jsonOf(await get(`/api/ar-ledger/balance?partyId=${partyAId}&projectId=${projectId}`, slugA))
  assert.equal(bal.balance, 700000)

  const entries = (await jsonOf(await get(`/api/ar-ledger?partyId=${partyAId}&projectId=${projectId}`, slugA))).items
  assert.deepEqual(
    entries.map((/** @type {any} */ e) => e.amount).sort((/** @type {number} */ a, /** @type {number} */ b) => a - b),
    [-300000, 1000000],
  )

  // 超额核销 → 409，余额不变
  const over = await post('/api/payments', { kind: 'ar', partyId: partyAId, projectId, amount: '800000.00' })
  assert.equal(over.status, 409)
  bal = await jsonOf(await get(`/api/ar-ledger/balance?partyId=${partyAId}&projectId=${projectId}`, slugA))
  assert.equal(bal.balance, 700000)
})

// ── 6. 项目毛利（M4 唯一验收点） ─────────────────────────────────────────────
test('项目毛利：合同 100 万 / 采购 60 万 / 分包 10 万 → gross=300000，grossRate=0.3', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await insertProject(`PPROFIT-${run}`)
  const contractId = await insertContract(projectId, '1000000.00')
  assert.ok(contractId)

  // 采购成本 60 万：PO 审批 + 全额收货（成本在收货时归集）
  const po = await jsonOf(
    await post('/api/purchase-orders', {
      projectId,
      partyId: partyAId,
      code: `PO-PROFIT-${run}`,
      lines: [{ itemId: itemAId, qty: '10', price: '60000.00' }],
    }),
  )
  assert.equal(po.amount, 600000)
  await post(`/api/purchase-orders/${po.id}/submit`, {})
  await approveDoc(slugA, po.id)
  const rc = await post('/api/goods-receipts', {
    poId: po.id,
    warehouseId: whAId,
    lines: [{ poLineId: po.lines[0].id, qty: '10' }],
  })
  await jsonAt(rc, 201)

  // 分包成本 10 万：合同审批 + 进度款审批
  const sub = await jsonOf(
    await post('/api/subcontracts', {
      projectId,
      partyId: partyAId,
      code: `SUB-PROFIT-${run}`,
      name: '劳务分包',
      amount: '100000.00',
    }),
  )
  await post(`/api/subcontracts/${sub.id}/submit`, {})
  await approveDoc(slugA, sub.id)
  const prog = await jsonOf(await post(`/api/subcontracts/${sub.id}/progress`, { seq: 1, amount: '100000.00' }))
  await post(`/api/subcontracts/${sub.id}/progress/${prog.id}/submit`, {})
  await approveDoc(slugA, prog.id)

  const profit = await profitOf(projectId)
  console.log('PROFIT_ASSERT', JSON.stringify(profit))
  assert.deepEqual(profit, { revenue: 1000000, cost: 700000, gross: 300000, grossRate: 0.3 })
  assert.equal(profit.grossRate, 0.3)

  // 手工核算：1000000.00 - (600000.00 + 100000.00) = 300000.00，一分不差
  assert.equal(profit.revenue - profit.cost, profit.gross)

  // 成本流水两条：采购 60 万 + 分包 10 万
  const costs = (await jsonOf(await get(`/api/cost-lines?projectId=${projectId}`, slugA))).items
  assert.deepEqual(
    costs.map((/** @type {any} */ c) => [c.source, c.amount]).sort(),
    [
      ['purchase', 600000],
      ['subcontract', 100000],
    ],
  )
})

// ── 7. 租户 / 字段 / 版本 ───────────────────────────────────────────────────
test('跨租户 404、未知字段 400、旧 version 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const po = await jsonOf(
    await post('/api/purchase-orders', newPoBody(slugA, `PO-GUARD-${run}`)),
  )

  // 跨租户：B 的凭证读 A 的采购单 / 毛利 → 404（不是 403）
  assert.equal((await get(`/api/purchase-orders/${po.id}`, slugB, cookieB)).status, 404)
  assert.equal((await get(`/api/purchase-orders/${po.id}`, slugB, cookieB)).status, 404)
  const projectId = await insertProject(`PGUARD-${run}`)
  assert.equal((await get(`/api/projects/${projectId}/profit`, slugB, cookieB)).status, 404)
  assert.equal((await get(`/api/projects/${randomUUID()}/profit`, slugA)).status, 404)

  // 未知字段 400
  assert.equal((await post('/api/purchase-orders', { ...newPoBody(slugA, `PO-X-${run}`), tenantId: tenantAId })).status, 400)
  assert.equal((await post('/api/goods-receipts', { poId: po.id, warehouseId: whAId, lines: [], hack: 1 })).status, 400)
  assert.equal((await post('/api/payments', { kind: 'ar', partyId: partyAId, amount: '1', unknown: true })).status, 400)

  // 旧 version → 409
  assert.equal((await patch(`/api/purchase-orders/${po.id}`, { note: 'x', version: 999 })).status, 409)
  assert.equal((await post(`/api/purchase-orders/${po.id}/submit`, { version: 999 })).status, 409)

  // 非法状态跳转：已审批的单不能再改状态（approve 由审批引擎驱动）
  const ok = await patch(`/api/purchase-orders/${po.id}`, { note: '正常备注', version: po.version })
  assert.equal((await jsonAt(ok, 200)).note, '正常备注')

  // 分包跨租户
  const sub = await jsonOf(
    await post('/api/subcontracts', {
      projectId,
      partyId: partyAId,
      code: `SUB-GUARD-${run}`,
      name: '守卫分包',
      amount: '1000.00',
    }),
  )
  assert.equal((await get(`/api/subcontracts/${sub.id}`, slugB, cookieB)).status, 404)
  assert.equal((await post(`/api/subcontracts/${sub.id}/submit`, { version: sub.version }, slugB, cookieB)).status, 404)

  // 另一租户的物料不能拿来建 PO（引用不存在于本租户 → 400，不泄露存在性）
  assert.equal(
    (await post('/api/purchase-orders', {
      partyId: partyBId,
      code: `PO-CROSS-${run}`,
      lines: [{ itemId: itemAId, qty: '1', price: '1' }],
    })).status,
    400,
  )
})
