import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { makeApp, jsonOf } from './helpers.mjs'
import { register } from '../api/routes-b.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { connect, exec } from '../db/index.mjs'

/**
 * 切片 B · 需求 + 方案 BOM。
 * project/party 是 A 切片的地盘，这里用直连 SQL 造前置数据，不 import 别人的 store。
 */

const password = 'test-pass-123'
const stamp = Date.now().toString(36)
const slugA = `m1ba${stamp}`
const slugB = `m1bb${stamp}`
const emailA = `m1ba-${stamp}@example.com`
const emailB = `m1bb-${stamp}@example.com`

/** @type {any} */
let app
let dbUp = false
let cookieA = ''
let cookieB = ''
let tenantA = ''
let projectA = ''
let projectA2 = ''

/** @param {string} tenantId @param {string} code */
async function seedProject(tenantId, code) {
  const now = new Date()
  const partyId = randomUUID()
  await exec(
    { tenantId },
    `INSERT INTO party (tenant_id, id, code, name, party_type, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'customer', 'active', 1, $5, $5)`,
    [tenantId, partyId, code, `客户 ${code}`, now],
  )
  const projectId = randomUUID()
  await exec(
    { tenantId },
    `INSERT INTO project (tenant_id, id, code, name, party_id, status, contract_amt, created_at, updated_at, version)
     VALUES ($1, $2, $3, $4, $5, 'approved', 0, $6, $6, 1)`,
    [tenantId, projectId, code, `项目 ${code}`, partyId, now],
  )
  return projectId
}

const bom = () => [
  { lineNo: 1, itemName: '核心交换机', spec: '48口', uom: '台', qty: 2, unitCost: 12000, note: '含三年保修' },
  { lineNo: 2, itemName: '光模块', uom: '个', qty: 8, unitCost: 350.5 },
]

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  const ctx = { requestId: 'test', userId: null }
  await createTenant(ctx, { slug: slugA, name: '甲 M1B', email: emailA, password })
  await createTenant(ctx, { slug: slugB, name: '乙 M1B', email: emailB, password })

  app = await makeApp(register)
  cookieA = await app.login(emailA, password)
  cookieB = await app.login(emailB, password)
  tenantA = (await jsonOf(await app.call('GET', `/t/${slugA}/api/me`, undefined, cookieA))).tenant.id
  projectA = await seedProject(tenantA, `PA1-${stamp}`)
  projectA2 = await seedProject(tenantA, `PA2-${stamp}`)
})

test.after(async () => {
  await app?.close()
})

test('需求：创建 draft → confirmed，confirmed 后再推进/非法跳转一律 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const created = await app.call(
    'POST',
    `/t/${slugA}/api/requirements`,
    { projectId: projectA, title: '现场勘察需求', content: '需要 3 次现场勘察' },
    cookieA,
  )
  assert.equal(created.status, 201)
  const req = await jsonOf(created)
  assert.equal(req.status, 'draft')
  assert.equal(req.projectId, projectA)
  assert.equal(req.confirmedAt, null)

  // 不是枚举值的目标 → 400（与其它四个切片的 advance 语义对齐）
  const bogus = await app.call('POST', `/t/${slugA}/api/requirements/${req.id}/advance`, { to: 'approved' }, cookieA)
  assert.equal(bogus.status, 400)

  // 是枚举值但当前状态不允许 → 409，带 allowed
  const bad = await app.call('POST', `/t/${slugA}/api/requirements/${req.id}/advance`, { to: 'draft' }, cookieA)
  assert.equal(bad.status, 409)
  assert.deepEqual((await jsonOf(bad)).error.details.allowed, ['confirmed'])

  const ok = await app.call('POST', `/t/${slugA}/api/requirements/${req.id}/advance`, { to: 'confirmed' }, cookieA)
  assert.equal(ok.status, 200)
  const confirmed = await jsonOf(ok)
  assert.equal(confirmed.status, 'confirmed')
  assert.ok(confirmed.confirmedAt)
  assert.ok(confirmed.confirmedBy)

  const again = await app.call('POST', `/t/${slugA}/api/requirements/${req.id}/advance`, { to: 'confirmed' }, cookieA)
  assert.equal(again.status, 409)
  assert.deepEqual((await jsonOf(again)).error.details.allowed, [])
})

test('需求：PATCH 改名；列表按 projectId/status 过滤', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const a = await jsonOf(
    await app.call('POST', `/t/${slugA}/api/requirements`, { projectId: projectA, title: '需求甲' }, cookieA),
  )
  const b = await jsonOf(
    await app.call('POST', `/t/${slugA}/api/requirements`, { projectId: projectA2, title: '需求乙' }, cookieA),
  )
  assert.notEqual(a.id, b.id)

  const patched = await app.call('PATCH', `/t/${slugA}/api/requirements/${a.id}`, { title: '需求甲-改' }, cookieA)
  assert.equal(patched.status, 200)
  const body = await jsonOf(patched)
  assert.equal(body.title, '需求甲-改')
  assert.equal(body.projectId, projectA)

  const listA = await jsonOf(
    await app.call('GET', `/t/${slugA}/api/requirements?projectId=${projectA}&limit=100`, undefined, cookieA),
  )
  assert.ok(listA.items.length >= 1)
  assert.ok(listA.items.every((/** @type {any} */ i) => i.projectId === projectA))
  assert.ok(!listA.items.some((/** @type {any} */ i) => i.id === b.id))

  await app.call('POST', `/t/${slugA}/api/requirements/${a.id}/advance`, { to: 'confirmed' }, cookieA)
  const confirmedOnly = await jsonOf(
    await app.call('GET', `/t/${slugA}/api/requirements?status=confirmed&limit=100`, undefined, cookieA),
  )
  assert.ok(confirmedOnly.items.some((/** @type {any} */ i) => i.id === a.id))
  assert.ok(confirmedOnly.items.every((/** @type {any} */ i) => i.status === 'confirmed'))

  // 详情
  const detail = await jsonOf(await app.call('GET', `/t/${slugA}/api/requirements/${a.id}`, undefined, cookieA))
  assert.equal(detail.title, '需求甲-改')
})

test('方案：创建带 bomLines，version=已有方案数+1，同项目再建 version=2', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const first = await app.call(
    'POST',
    `/t/${slugA}/api/design-docs`,
    { projectId: projectA, title: '方案一', content: '初版', bomLines: bom() },
    cookieA,
  )
  assert.equal(first.status, 201)
  const d1 = await jsonOf(first)
  assert.equal(d1.version, 1)
  assert.equal(d1.status, 'draft')
  assert.equal(d1.bomLines.length, 2)
  assert.equal(d1.bomLines[0].lineNo, 1)
  assert.equal(d1.bomLines[0].qty, 2)
  assert.equal(d1.bomLines[0].unitCost, 12000)
  assert.equal(d1.bomLines[1].unitCost, 350.5)

  const second = await jsonOf(
    await app.call(
      'POST',
      `/t/${slugA}/api/design-docs`,
      { projectId: projectA, title: '方案二', bomLines: [bom()[0]] },
      cookieA,
    ),
  )
  assert.equal(second.version, 2)
  assert.equal(second.bomLines.length, 1)

  // 详情必须按 line_no 返回 lines
  const detail = await jsonOf(await app.call('GET', `/t/${slugA}/api/design-docs/${d1.id}`, undefined, cookieA))
  assert.deepEqual(detail.bomLines.map((/** @type {any} */ l) => l.lineNo), [1, 2])
  assert.deepEqual(detail.bomLines.map((/** @type {any} */ l) => l.itemName), ['核心交换机', '光模块'])
})

test('方案：列表按 projectId 过滤', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const other = await jsonOf(
    await app.call(
      'POST',
      `/t/${slugA}/api/design-docs`,
      { projectId: projectA2, title: '别的项目方案', bomLines: [bom()[0]] },
      cookieA,
    ),
  )
  assert.equal(other.version, 1, '版本号按项目独立计数')

  const list = await jsonOf(
    await app.call('GET', `/t/${slugA}/api/design-docs?projectId=${projectA2}&limit=100`, undefined, cookieA),
  )
  assert.ok(list.items.length >= 1)
  assert.ok(list.items.every((/** @type {any} */ i) => i.projectId === projectA2))
  assert.ok(list.items.some((/** @type {any} */ i) => i.id === other.id))
})

test('方案 PATCH：bomLines 是整批替换（删旧插新），content 一起更新', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const doc = await jsonOf(
    await app.call('POST', `/t/${slugA}/api/design-docs`, { projectId: projectA2, title: '待改方案', bomLines: bom() }, cookieA),
  )
  assert.equal(doc.bomLines.length, 2)

  const res = await app.call(
    'PATCH',
    `/t/${slugA}/api/design-docs/${doc.id}`,
    { version: doc.version, content: '换成国产设备', bomLines: [{ lineNo: 1, itemName: '国产交换机', qty: 3, unitCost: 8000 }] },
    cookieA,
  )
  assert.equal(res.status, 200)
  const body = await jsonOf(res)
  assert.equal(body.content, '换成国产设备')
  assert.equal(body.bomLines.length, 1)
  assert.equal(body.bomLines[0].itemName, '国产交换机')
  assert.equal(body.bomLines[0].qty, 3)
  assert.equal(body.bomLines[0].spec, null, '旧行的 spec 不能残留')

  const detail = await jsonOf(await app.call('GET', `/t/${slugA}/api/design-docs/${doc.id}`, undefined, cookieA))
  assert.equal(detail.bomLines.length, 1)
  assert.ok(!detail.bomLines.some((/** @type {any} */ l) => l.itemName === '核心交换机'))
})

test('方案：confirmed 后 PATCH → 409；重复 advance → 409；旧 version → 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const doc = await jsonOf(
    await app.call('POST', `/t/${slugA}/api/design-docs`, { projectId: projectA, title: '待确认方案', bomLines: bom() }, cookieA),
  )

  const stale = await app.call(
    'PATCH',
    `/t/${slugA}/api/design-docs/${doc.id}`,
    { version: doc.version + 5, content: '旧版本改' },
    cookieA,
  )
  assert.equal(stale.status, 409)
  assert.match((await jsonOf(stale)).error.details.reason, /版本已变/)

  const ok = await app.call('POST', `/t/${slugA}/api/design-docs/${doc.id}/advance`, { to: 'confirmed' }, cookieA)
  assert.equal(ok.status, 200)
  assert.equal((await jsonOf(ok)).status, 'confirmed')

  const locked = await app.call(
    'PATCH',
    `/t/${slugA}/api/design-docs/${doc.id}`,
    { version: doc.version, bomLines: [bom()[0]] },
    cookieA,
  )
  assert.equal(locked.status, 409)
  assert.match((await jsonOf(locked)).error.details.reason, /draft/)

  const again = await app.call('POST', `/t/${slugA}/api/design-docs/${doc.id}/advance`, { to: 'confirmed' }, cookieA)
  assert.equal(again.status, 409)
  assert.deepEqual((await jsonOf(again)).error.details.allowed, [])
})

test('跨租户：B 的 cookie 读/改 A 的需求与方案 → 404，列表不串', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const req = await jsonOf(
    await app.call('POST', `/t/${slugA}/api/requirements`, { projectId: projectA, title: 'A 的需求' }, cookieA),
  )
  const doc = await jsonOf(
    await app.call('POST', `/t/${slugA}/api/design-docs`, { projectId: projectA, title: 'A 的方案', bomLines: bom() }, cookieA),
  )

  assert.equal((await app.call('GET', `/t/${slugB}/api/requirements/${req.id}`, undefined, cookieB)).status, 404)
  assert.equal((await app.call('PATCH', `/t/${slugB}/api/requirements/${req.id}`, { title: '偷改' }, cookieB)).status, 404)
  assert.equal(
    (await app.call('POST', `/t/${slugB}/api/requirements/${req.id}/advance`, { to: 'confirmed' }, cookieB)).status,
    404,
  )
  assert.equal((await app.call('GET', `/t/${slugB}/api/design-docs/${doc.id}`, undefined, cookieB)).status, 404)
  assert.equal(
    (await app.call('PATCH', `/t/${slugB}/api/design-docs/${doc.id}`, { version: doc.version, content: '偷改' }, cookieB))
      .status,
    404,
  )
  assert.equal(
    (await app.call('POST', `/t/${slugB}/api/design-docs/${doc.id}/advance`, { to: 'confirmed' }, cookieB)).status,
    404,
  )

  // 拿 A 的 projectId 在 B 里建单 → 项目对 B 不存在，404
  assert.equal(
    (await app.call('POST', `/t/${slugB}/api/requirements`, { projectId: projectA, title: '串租户' }, cookieB)).status,
    404,
  )
  assert.equal(
    (await app.call('POST', `/t/${slugB}/api/design-docs`, { projectId: projectA, title: '串租户', bomLines: bom() }, cookieB))
      .status,
    404,
  )

  const listB = await jsonOf(await app.call('GET', `/t/${slugB}/api/requirements?limit=100`, undefined, cookieB))
  assert.ok(!listB.items.some((/** @type {any} */ i) => i.id === req.id))
  const docsB = await jsonOf(await app.call('GET', `/t/${slugB}/api/design-docs?limit=100`, undefined, cookieB))
  assert.ok(!docsB.items.some((/** @type {any} */ i) => i.id === doc.id))
})

test('项目不存在 / id 非法：建单 404，非 uuid 的 id 也是 404 而不是 500', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  assert.equal(
    (await app.call('POST', `/t/${slugA}/api/requirements`, { projectId: randomUUID(), title: '无项目' }, cookieA)).status,
    404,
  )
  assert.equal(
    (await app.call('POST', `/t/${slugA}/api/design-docs`, { projectId: randomUUID(), title: '无项目', bomLines: bom() }, cookieA))
      .status,
    404,
  )
  assert.equal(
    (await app.call('POST', `/t/${slugA}/api/requirements`, { projectId: 'not-a-uuid', title: '坏项目' }, cookieA)).status,
    404,
  )
  assert.equal((await app.call('GET', `/t/${slugA}/api/requirements/not-a-uuid`, undefined, cookieA)).status, 404)
  assert.equal((await app.call('GET', `/t/${slugA}/api/design-docs/${randomUUID()}`, undefined, cookieA)).status, 404)
})

test('未知字段 / BOM 行校验 → 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const extra = await app.call(
    'POST',
    `/t/${slugA}/api/requirements`,
    { projectId: projectA, title: '偷偷加字段', tenantId: 'evil' },
    cookieA,
  )
  assert.equal(extra.status, 400)
  assert.match((await jsonOf(extra)).error.details.reason, /未知字段/)

  const emptyTitle = await app.call('POST', `/t/${slugA}/api/requirements`, { projectId: projectA }, cookieA)
  assert.equal(emptyTitle.status, 400)
  assert.equal((await jsonOf(emptyTitle)).error.details.fields.title, 'required')

  const extraDoc = await app.call(
    'POST',
    `/t/${slugA}/api/design-docs`,
    { projectId: projectA, title: '方案', bomLines: bom(), status: 'confirmed' },
    cookieA,
  )
  assert.equal(extraDoc.status, 400)
  assert.match((await jsonOf(extraDoc)).error.details.reason, /未知字段/)

  const extraLine = await app.call(
    'POST',
    `/t/${slugA}/api/design-docs`,
    { projectId: projectA, title: '方案', bomLines: [{ lineNo: 1, itemName: '甲', qty: 1, unitCost: 1, price: 2 }] },
    cookieA,
  )
  assert.equal(extraLine.status, 400)
  assert.match((await jsonOf(extraLine)).error.details.reason, /未知字段 bomLines\[0\]\.price/)

  const dupLine = await app.call(
    'POST',
    `/t/${slugA}/api/design-docs`,
    { projectId: projectA, title: '方案', bomLines: [bom()[0], bom()[0]] },
    cookieA,
  )
  assert.equal(dupLine.status, 400)
  assert.equal((await jsonOf(dupLine)).error.details.fields['bomLines[1].lineNo'], 'duplicate')

  const badMoney = await app.call(
    'POST',
    `/t/${slugA}/api/design-docs`,
    { projectId: projectA, title: '方案', bomLines: [{ lineNo: 1, itemName: '甲', qty: 'abc', unitCost: 1 }] },
    cookieA,
  )
  assert.equal(badMoney.status, 400)
  assert.equal((await jsonOf(badMoney)).error.details.fields['bomLines[0].qty'], 'money')

  const notArray = await app.call(
    'POST',
    `/t/${slugA}/api/design-docs`,
    { projectId: projectA, title: '方案', bomLines: 'x' },
    cookieA,
  )
  assert.equal(notArray.status, 400)
  assert.equal((await jsonOf(notArray)).error.details.fields.bomLines, 'array')
})
