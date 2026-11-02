import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { connect, exec } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { register } from '../api/routes-c.mjs'
import { createTenant } from '../svc/tenant.mjs'
import * as svc from '../svc/quotation.mjs'

const password = 'test-pass-123'
const tag = randomUUID().slice(0, 8)
const ownerA = `qca-${tag}@example.com`
const ownerB = `qcb-${tag}@example.com`
const slugA = `qca${tag}`
const slugB = `qcb${tag}`

/** @type {any} */
let app
let dbUp = false
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''
/** @type {string} */
let tenantA = ''
/** @type {string} */
let tenantB = ''
/** @type {string} */
let partyA = ''
/** @type {string} */
let partyB = ''

/** 三条 BOM 行，金额故意带两位小数：2*1234.56 + 100*3.33 + 1*500.00 = 3302.12 */
const BOM = [
  { lineNo: 1, itemName: 'PLC 柜', spec: 'S7-1200', uom: '台', qty: '2', unitCost: '1234.56' },
  { lineNo: 2, itemName: '网线', spec: 'CAT6', uom: '米', qty: '100', unitCost: '3.33' },
  { lineNo: 3, itemName: '施工费', spec: null, uom: '项', qty: '1', unitCost: '500.00' },
]

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲集成', email: ownerA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙集成', email: ownerB, password })
  app = await makeApp(register)
  cookieA = await app.login(ownerA, password)
  cookieB = await app.login(ownerB, password)
  tenantA = (await jsonOf(await app.call('GET', `/t/${slugA}/api/me`, undefined, cookieA))).tenant.id
  tenantB = (await jsonOf(await app.call('GET', `/t/${slugB}/api/me`, undefined, cookieB))).tenant.id
  partyA = await makeParty(slugA, cookieA, `QC-${tag}-A`)
  partyB = await makeParty(slugB, cookieB, `QC-${tag}-B`)
})

test.after(async () => {
  await app?.close()
})

/**
 * 前置数据（B 切片的表）一律自己写 SQL，不 import 别人的 store
 * @param {string} slug @param {string} cookie @param {string} code
 */
async function makeParty(slug, cookie, code) {
  const res = await app.call('POST', `/t/${slug}/api/parties`, { code, name: `客户 ${code}`, partyType: 'customer' }, cookie)
  assert.equal(res.status, 201)
  return (await jsonOf(res)).id
}

/**
 * 造 project + design_doc(+bom_line)
 * @param {{ tenantId: string, partyId: string, docStatus?: string, projectStatus?: string, bom?: typeof BOM }} p
 */
async function seed(p) {
  const projectId = randomUUID()
  const designDocId = randomUUID()
  const now = new Date()
  await exec(
    { tenantId: p.tenantId },
    `INSERT INTO project (tenant_id, id, code, name, party_id, status, contract_amt, created_at, updated_at, version)
     VALUES ($1, $2, $3, $4, $5, $6, '0.00', $7, $7, 1)`,
    [p.tenantId, projectId, `P-${randomUUID().slice(0, 8)}`, '某厂自动化改造', p.partyId, p.projectStatus ?? 'quoting', now],
  )
  await exec(
    { tenantId: p.tenantId },
    `INSERT INTO design_doc (tenant_id, id, project_id, title, version, content, status, confirmed_by, confirmed_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $9)`,
    [
      p.tenantId,
      designDocId,
      projectId,
      'V1 方案',
      '方案正文',
      p.docStatus ?? 'confirmed',
      (p.docStatus ?? 'confirmed') === 'confirmed' ? randomUUID() : null,
      (p.docStatus ?? 'confirmed') === 'confirmed' ? now : null,
      now,
    ],
  )
  for (const l of p.bom ?? BOM) {
    await exec(
      { tenantId: p.tenantId },
      `INSERT INTO bom_line (tenant_id, id, design_doc_id, line_no, item_name, spec, uom, qty, unit_cost, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.tenantId, randomUUID(), designDocId, l.lineNo, l.itemName, l.spec, l.uom, l.qty, l.unitCost, null],
    )
  }
  return { projectId, designDocId }
}

/** 常用：A 租户造一套 confirmed 方案 */
const seedA = (/** @type {any} */ [override] = [{}]) => seed({ tenantId: tenantA, partyId: partyA, ...override })

/** @param {string} path @param {unknown} [body] @param {string} [cookie] */
const post = (path, body, cookie = cookieA) => app.call('POST', path, /** @type {any} */ (body), cookie)
/** @param {string} path @param {string} [cookie] */
const get = (path, cookie = cookieA) => app.call('GET', path, undefined, cookie)

/** 分：避开浮点比较 */
const cents = (/** @type {number} */ n) => Math.round(n * 100)

test('金额：按分用整数算，四舍五入到 2 位', () => {
  assert.equal(svc.moneyOf(svc.lineAmountCents('3', '1234.56')), '3703.68')
  assert.equal(svc.moneyOf(svc.lineAmountCents('1', '0.005')), '0.01', '第三位小数 half-up')
  assert.equal(svc.moneyOf(svc.centsOf(0.1 + 0.2)), '0.30', '不做浮点累加')
  assert.equal(svc.moneyOf(svc.centsOf('100')), '100.00')
  assert.equal(svc.centsOf('1234.56'), 123456)
})

test('从 confirmed 方案生成报价：行数与 BOM 一致，price 取 unit_cost，amount=qty*price，合计正确', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const { projectId, designDocId } = await seedA()

  const res = await post(`/t/${slugA}/api/quotations`, { designDocId })
  assert.equal(res.status, 201)
  const body = await jsonOf(res)
  assert.equal(body.status, 'draft')
  assert.equal(body.version, 1)
  assert.equal(body.code, `Q-${designDocId.slice(0, 8)}-1`)
  assert.equal(body.projectId, projectId)
  assert.equal(body.partyId, partyA, 'party_id 从 project 继承')
  assert.equal(body.lines.length, BOM.length, '行数与 BOM 一致')
  assert.deepEqual(body.lines.map((/** @type {any} */ l) => l.lineNo), [1, 2, 3])
  assert.equal(body.lines[0].itemName, 'PLC 柜')
  assert.equal(body.lines[0].spec, 'S7-1200')
  assert.equal(body.lines[0].uom, '台')
  assert.equal(body.lines[0].price, 1234.56, 'price 默认取 unit_cost')
  assert.equal(cents(body.lines[0].amount), 246912, 'amount = qty * price')
  assert.equal(cents(body.lines[2].amount), 50000)
  assert.equal(cents(body.amount), 330212, '合计 = 各行 amount 之和')

  // 列表能查到
  const list = await jsonOf(await get(`/t/${slugA}/api/quotations?projectId=${projectId}`))
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].id, body.id)

  // 报价行是 BOM 快照：改 BOM 不动已生成的报价
  await exec(
    { tenantId: tenantA },
    `UPDATE bom_line SET unit_cost = '9999.00' WHERE $t AND design_doc_id = $1`,
    [designDocId],
  )
  const again = await jsonOf(await get(`/t/${slugA}/api/quotations/${body.id}`))
  assert.equal(again.lines[0].price, 1234.56, '源单改版不能动已发出的单据')
  assert.equal(cents(again.amount), 330212)
})

test('priceLines 覆盖指定行单价；lineNo 不在 BOM → 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const { designDocId } = await seedA()

  const res = await post(`/t/${slugA}/api/quotations`, {
    designDocId,
    priceLines: [
      { lineNo: 2, price: '4.10' },
      { lineNo: 3, price: 0 },
    ],
  })
  assert.equal(res.status, 201)
  const body = await jsonOf(res)
  assert.equal(body.lines[0].price, 1234.56, '没指定的行仍用 unit_cost')
  assert.equal(body.lines[1].price, 4.1)
  assert.equal(cents(body.lines[1].amount), 41000, '100 * 4.10')
  assert.equal(cents(body.lines[2].amount), 0)
  assert.equal(cents(body.amount), 246912 + 41000)

  const stray = await post(`/t/${slugA}/api/quotations`, { designDocId, priceLines: [{ lineNo: 9, price: '1' }] })
  assert.equal(stray.status, 400)

  const dup = await post(`/t/${slugA}/api/quotations`, {
    designDocId,
    priceLines: [
      { lineNo: 1, price: '1' },
      { lineNo: 1, price: '2' },
    ],
  })
  assert.equal(dup.status, 400)
})

test('方案未 confirmed → 409；designDocId 不存在/非 uuid → 404', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const draft = await seedA([{ docStatus: 'draft' }])
  const res = await post(`/t/${slugA}/api/quotations`, { designDocId: draft.designDocId })
  assert.equal(res.status, 409)
  assert.match((await jsonOf(res)).error.details.reason, /确认后才能出报价/)

  assert.equal((await post(`/t/${slugA}/api/quotations`, { designDocId: randomUUID() })).status, 404)
  assert.equal((await post(`/t/${slugA}/api/quotations`, { designDocId: 'not-a-uuid' })).status, 404)
  assert.equal((await get(`/t/${slugA}/api/quotations/${randomUUID()}`)).status, 404)
  assert.equal((await get(`/t/${slugA}/api/quotations/not-a-uuid`)).status, 404)
})

test('状态机：draft→sent→accepted 正常；accepted→sent 非法 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const { designDocId } = await seedA()
  const created = await jsonOf(await post(`/t/${slugA}/api/quotations`, { designDocId }))

  const sent = await post(`/t/${slugA}/api/quotations/${created.id}/advance`, { to: 'sent' })
  assert.equal(sent.status, 200)
  const sentBody = await jsonOf(sent)
  assert.equal(sentBody.status, 'sent')
  assert.ok(sentBody.sentAt, 'sent 时写 sent_at')

  const accepted = await jsonOf(await post(`/t/${slugA}/api/quotations/${created.id}/advance`, { to: 'accepted' }))
  assert.equal(accepted.status, 'accepted')
  assert.ok(accepted.decidedAt, 'accepted 时写 decided_at')

  const back = await post(`/t/${slugA}/api/quotations/${created.id}/advance`, { to: 'sent' })
  assert.equal(back.status, 409)
  assert.deepEqual((await jsonOf(back)).error.details.allowed, [])

  const skip = await seedA()
  const created2 = await jsonOf(await post(`/t/${slugA}/api/quotations`, { designDocId: skip.designDocId }))
  const jump = await post(`/t/${slugA}/api/quotations/${created2.id}/advance`, { to: 'accepted' })
  assert.equal(jump.status, 409, 'draft 不能直接 accepted')
  assert.deepEqual((await jsonOf(jump)).error.details.allowed, ['sent'])

  // rejected 分支
  await post(`/t/${slugA}/api/quotations/${created2.id}/advance`, { to: 'sent' })
  const rejected = await jsonOf(await post(`/t/${slugA}/api/quotations/${created2.id}/advance`, { to: 'rejected' }))
  assert.equal(rejected.status, 'rejected')

  // to 不在枚举里 → 400（不是 409）
  assert.equal((await post(`/t/${slugA}/api/quotations/${created2.id}/advance`, { to: 'won' })).status, 400)
})

test('version 递增：同一项目第二次出报价 version=2；显式 code 重复 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const { projectId, designDocId } = await seedA()
  const first = await jsonOf(await post(`/t/${slugA}/api/quotations`, { designDocId }))
  const second = await jsonOf(await post(`/t/${slugA}/api/quotations`, { designDocId }))
  assert.equal(first.version, 1)
  assert.equal(second.version, 2, 'version = 该项目已有报价数 + 1')
  assert.notEqual(first.code, second.code)

  const list = await jsonOf(await get(`/t/${slugA}/api/quotations?projectId=${projectId}&status=draft`))
  assert.deepEqual(list.items.map((/** @type {any} */ i) => i.version).sort(), [1, 2])

  const custom = `QC-${tag}-X`
  assert.equal((await post(`/t/${slugA}/api/quotations`, { designDocId, code: custom })).status, 201)
  const dup = await post(`/t/${slugA}/api/quotations`, { designDocId, code: custom })
  assert.equal(dup.status, 409)
  assert.match((await jsonOf(dup)).error.details.reason, /已存在/)
})

test('跨租户：B 读/推进 A 的报价 404；B 拿 A 的方案出报价 404；B 列表不含 A', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const a = await seedA()
  const created = await jsonOf(await post(`/t/${slugA}/api/quotations`, { designDocId: a.designDocId }))

  assert.equal((await get(`/t/${slugB}/api/quotations/${created.id}`, cookieB)).status, 404)
  assert.equal((await post(`/t/${slugB}/api/quotations/${created.id}/advance`, { to: 'sent' }, cookieB)).status, 404)
  assert.equal(
    (await post(`/t/${slugB}/api/quotations`, { designDocId: a.designDocId }, cookieB)).status,
    404,
    '跨租户的方案当不存在',
  )

  const listB = await jsonOf(await get(`/t/${slugB}/api/quotations`, cookieB))
  assert.ok(!listB.items.some((/** @type {any} */ i) => i.id === created.id))
  assert.equal(listB.items.length, 0, 'B 还没有自己的报价')
})

test('未知字段 → 400；必填缺失 → 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const { designDocId } = await seedA()

  const extra = await post(`/t/${slugA}/api/quotations`, { designDocId, tenantId: 'x' })
  assert.equal(extra.status, 400)
  assert.match((await jsonOf(extra)).error.details.reason, /未知字段/)

  const lineExtra = await post(`/t/${slugA}/api/quotations`, {
    designDocId,
    priceLines: [{ lineNo: 1, price: '1', amount: '1' }],
  })
  assert.equal(lineExtra.status, 400)
  assert.match((await jsonOf(lineExtra)).error.details.reason, /未知字段/)

  const missing = await post(`/t/${slugA}/api/quotations`, {})
  assert.equal(missing.status, 400)
  assert.equal((await jsonOf(missing)).error.details.fields.designDocId, 'required')

  const badPrice = await post(`/t/${slugA}/api/quotations`, { designDocId, priceLines: [{ lineNo: 1, price: 'abc' }] })
  assert.equal(badPrice.status, 400)
})
