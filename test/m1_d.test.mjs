import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { connect, exec, q } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { register } from '../api/routes-d.mjs'
import { createTenant } from '../svc/tenant.mjs'

/**
 * 切片 D · 合同。前置数据（party / project / quotation / quotation_line）用
 * 自己写的直连 SQL 造，不 import 别的切片的 store（并行期避免编译耦合）。
 */

const password = 'test-pass-123'
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const ownerA = `da-${stamp}@example.com`
const ownerB = `db-${stamp}@example.com`
const slugA = `da${stamp}`
const slugB = `db${stamp}`

/** @type {any} */
let app
let dbUp = false
let cookieA = ''
let cookieB = ''
let tenantA = ''
let tenantB = ''
let userA = ''

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  await exec({}, 'DELETE FROM login_attempt', [])
  const ctx = { requestId: 'test', userId: null }
  await createTenant(ctx, { slug: slugA, name: '甲合同公司', email: ownerA, password })
  await createTenant(ctx, { slug: slugB, name: '乙合同公司', email: ownerB, password })

  app = await makeApp(register)
  cookieA = await app.login(ownerA, password)
  cookieB = await app.login(ownerB, password)
  const meA = await jsonOf(await app.call('GET', `/t/${slugA}/api/me`, undefined, cookieA))
  const meB = await jsonOf(await app.call('GET', `/t/${slugB}/api/me`, undefined, cookieB))
  tenantA = meA.tenant.id
  tenantB = meB.tenant.id
  userA = meA.user.id
})

test.after(async () => {
  await app?.close()
})

/**
 * 直连 SQL 造一条「客户 → 项目(quoting) → 报价(accepted) → 2 行报价行」。
 * @param {string} tenantId
 * @param {string} tag
 * @param {{ quotationStatus?: string, projectStatus?: string, amount?: string }} [opts]
 */
async function seedChain(tenantId, tag, opts = {}) {
  const now = new Date()
  const partyId = randomUUID()
  const projectId = randomUUID()
  const quotationId = randomUUID()
  const amount = opts.amount ?? '1234.56'

  await exec(
    { tenantId },
    `INSERT INTO party (tenant_id, id, code, name, party_type, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'customer', 'active', 1, $5, $5)`,
    [tenantId, partyId, `PT-${tag}`, `客户 ${tag}`, now],
  )
  await exec(
    { tenantId },
    `INSERT INTO project (tenant_id, id, code, name, party_id, status, contract_amt, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 0, 1, $7, $7)`,
    [tenantId, projectId, `P-${tag}`, `项目 ${tag}`, partyId, opts.projectStatus ?? 'quoting', now],
  )
  await exec(
    { tenantId },
    `INSERT INTO quotation (tenant_id, id, project_id, code, version, party_id, amount, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $8)`,
    [tenantId, quotationId, projectId, `Q-${tag}`, partyId, amount, opts.quotationStatus ?? 'accepted', now],
  )
  await exec(
    { tenantId },
    `INSERT INTO quotation_line (tenant_id, id, quotation_id, line_no, item_name, spec, uom, qty, price, amount)
     VALUES ($1, $2, $3, 1, '设备A', 'DN100', '台', 2, 500.00, 1000.00)`,
    [tenantId, randomUUID(), quotationId],
  )
  await exec(
    { tenantId },
    `INSERT INTO quotation_line (tenant_id, id, quotation_id, line_no, item_name, spec, uom, qty, price, amount)
     VALUES ($1, $2, $3, 2, '设备B', 'DN50', '台', 1, 234.56, 234.56)`,
    [tenantId, randomUUID(), quotationId],
  )
  return { partyId, projectId, quotationId, amount }
}

/** @param {string} slug @param {string} cookie @param {string} quotationId @param {string} code @param {Record<string, unknown>} [extra] */
const postContract = (slug, cookie, quotationId, code, extra = {}) =>
  app.call('POST', `/t/${slug}/api/contracts`, { quotationId, code, name: `合同 ${code}`, ...extra }, cookie)

test('从 accepted 报价生成合同：行数、金额、客户继承 + 审计', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `c1-${stamp}`)

  const res = await postContract(slugA, cookieA, s.quotationId, 'HT-001')
  assert.equal(res.status, 201)
  const body = await jsonOf(res)
  assert.equal(body.status, 'draft')
  assert.equal(body.amount, 1234.56)
  assert.equal(body.partyId, s.partyId)
  assert.equal(body.projectId, s.projectId)
  assert.equal(body.quotationId, s.quotationId)
  assert.equal(body.signAt, null)
  assert.deepEqual(body.allowed, ['signed'])

  const detail = await jsonOf(await app.call('GET', `/t/${slugA}/api/contracts/${body.id}`, undefined, cookieA))
  assert.equal(detail.lines.length, 2, '行数应与报价行一致')
  assert.deepEqual(
    detail.lines.map((/** @type {any} */ l) => l.lineNo),
    [1, 2],
  )
  assert.equal(detail.lines[0].itemName, '设备A')
  assert.equal(detail.lines[0].spec, 'DN100')
  assert.equal(detail.lines[0].uom, '台')
  assert.equal(detail.lines[0].qty, 2)
  assert.equal(detail.lines[0].price, 500)
  assert.equal(detail.lines[0].amount, 1000)
  assert.deepEqual(detail.terms, [])

  const rows = await q(
    { tenantId: tenantA },
    `SELECT COUNT(*) AS n FROM contract_line WHERE $t AND contract_id = $1`,
    [body.id],
  )
  assert.equal(Number(rows[0].n), 2)
  const audits = await q({ tenantId: tenantA }, `SELECT action FROM audit_log WHERE $t AND ref_id = $1`, [body.id])
  assert.deepEqual(
    audits.map((/** @type {any} */ r) => r.action),
    ['create'],
  )
})

test('terms 建行、seq 从 1 递增，GET 详情同时返回 lines+terms', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `t2-${stamp}`)
  const terms = [
    { seq: 9, title: '付款方式', content: '签约后 30 日内付 30%' },
    { seq: 3, title: '质保期', content: '验收之日起 24 个月' },
  ]
  const res = await postContract(slugA, cookieA, s.quotationId, 'HT-TERM', { terms })
  assert.equal(res.status, 201)
  const body = await jsonOf(res)
  assert.equal(body.terms.length, 2)
  assert.deepEqual(
    body.terms.map((/** @type {any} */ x) => x.seq),
    [1, 2],
  )
  assert.deepEqual(
    body.terms.map((/** @type {any} */ x) => x.title),
    ['付款方式', '质保期'],
  )
  assert.equal(body.lines.length, 2)

  const rows = await q(
    { tenantId: tenantA },
    `SELECT seq, title FROM contract_term WHERE $t AND contract_id = $1 ORDER BY seq`,
    [body.id],
  )
  assert.deepEqual(
    rows.map((/** @type {any} */ r) => r.seq),
    [1, 2],
  )
})

test('报价不是 accepted → 409，且不落合同', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `t3-${stamp}`, { quotationStatus: 'sent' })
  const res = await postContract(slugA, cookieA, s.quotationId, 'HT-SENT')
  assert.equal(res.status, 409)
  const body = await jsonOf(res)
  assert.equal(body.error.code, 'conflict')
  assert.deepEqual(body.error.details.allowed, ['accepted'])

  const rows = await q({ tenantId: tenantA }, `SELECT id FROM contract WHERE $t AND code = $1`, ['HT-SENT'])
  assert.equal(rows.length, 0)
})

test('quotationId 不存在 → 404；非 uuid 也是 404', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const res = await postContract(slugA, cookieA, randomUUID(), 'HT-NOQUO')
  assert.equal(res.status, 404)
  const res2 = await postContract(slugA, cookieA, 'not-a-uuid', 'HT-BADID')
  assert.equal(res2.status, 404)
})

test('draft→signed：写 sign_at、同事务把 project 推到 signed、补 project_stage_log(quoting→signed)', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `t5-${stamp}`)
  const created = await jsonOf(await postContract(slugA, cookieA, s.quotationId, 'HT-SIGN'))

  const before = await q(
    { tenantId: tenantA },
    `SELECT COUNT(*) AS n FROM project_stage_log WHERE $t AND project_id = $1`,
    [s.projectId],
  )

  const res = await app.call(
    'POST',
    `/t/${slugA}/api/contracts/${created.id}/advance`,
    { to: 'signed' },
    cookieA,
  )
  assert.equal(res.status, 200)
  const signed = await jsonOf(res)
  assert.equal(signed.status, 'signed')
  assert.ok(signed.signAt, 'sign_at 应被写上')
  assert.deepEqual(signed.allowed, [])

  const contracts = await q(
    { tenantId: tenantA },
    `SELECT status, sign_at FROM contract WHERE $t AND id = $1`,
    [created.id],
  )
  assert.equal(contracts[0].status, 'signed')
  assert.ok(contracts[0].sign_at)

  const projects = await q({ tenantId: tenantA }, `SELECT status, version FROM project WHERE $t AND id = $1`, [
    s.projectId,
  ])
  assert.equal(projects[0].status, 'signed', '签约应同事务推进 project')
  assert.equal(projects[0].version, 2)

  const logs = await q(
    { tenantId: tenantA },
    `SELECT from_status, to_status, actor_id, note FROM project_stage_log
      WHERE $t AND project_id = $1 ORDER BY at, id`,
    [s.projectId],
  )
  assert.equal(logs.length, Number(before[0].n) + 1)
  const last = logs[logs.length - 1]
  assert.equal(last.from_status, 'quoting')
  assert.equal(last.to_status, 'signed')
  assert.equal(last.note, '合同签署')
  assert.equal(last.actor_id, userA)
})

test('建合同时给了 signAt：签约沿用该签署时间', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `t6-${stamp}`)
  const created = await jsonOf(
    await postContract(slugA, cookieA, s.quotationId, 'HT-PRESIGN', { signAt: '2026-03-01T00:00:00.000Z' }),
  )
  assert.equal(created.signAt, '2026-03-01T00:00:00.000Z')
  const signed = await jsonOf(
    await app.call('POST', `/t/${slugA}/api/contracts/${created.id}/advance`, { to: 'signed' }, cookieA),
  )
  assert.equal(signed.status, 'signed')
  assert.equal(signed.signAt, '2026-03-01T00:00:00.000Z')
})

test('signed→draft 非法 → 409，allowed 为空', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `t7-${stamp}`)
  const created = await jsonOf(await postContract(slugA, cookieA, s.quotationId, 'HT-BACK'))
  assert.equal(
    (await app.call('POST', `/t/${slugA}/api/contracts/${created.id}/advance`, { to: 'signed' }, cookieA)).status,
    200,
  )
  const res = await app.call('POST', `/t/${slugA}/api/contracts/${created.id}/advance`, { to: 'draft' }, cookieA)
  assert.equal(res.status, 409)
  const body = await jsonOf(res)
  assert.equal(body.error.code, 'conflict')
  assert.deepEqual(body.error.details.allowed, [])
})

test('跨租户：B 读/推进 A 的合同 → 404，列表也看不到', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `t8-${stamp}`)
  const created = await jsonOf(await postContract(slugA, cookieA, s.quotationId, 'HT-XTEN'))

  assert.equal((await app.call('GET', `/t/${slugB}/api/contracts/${created.id}`, undefined, cookieB)).status, 404)
  assert.equal(
    (await app.call('POST', `/t/${slugB}/api/contracts/${created.id}/advance`, { to: 'signed' }, cookieB)).status,
    404,
  )
  const listB = await jsonOf(await app.call('GET', `/t/${slugB}/api/contracts`, undefined, cookieB))
  assert.deepEqual(listB.items, [])

  // A 自己还能读到；B 的报价也不能拿来签合同
  assert.equal((await app.call('GET', `/t/${slugA}/api/contracts/${created.id}`, undefined, cookieA)).status, 200)
  assert.equal((await postContract(slugB, cookieB, s.quotationId, 'HT-LEASE')).status, 404)
  assert.ok(tenantB)
})

test('未知字段 → 400（含 terms 内未知字段）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `t9-${stamp}`)
  const res = await app.call(
    'POST',
    `/t/${slugA}/api/contracts`,
    { quotationId: s.quotationId, code: 'HT-X', name: '合同 X', tenantId: tenantA },
    cookieA,
  )
  assert.equal(res.status, 400)
  const body = await jsonOf(res)
  assert.equal(body.error.code, 'bad_request')
  assert.match(String(body.error.details.reason), /未知字段/)

  const res2 = await app.call(
    'POST',
    `/t/${slugA}/api/contracts`,
    {
      quotationId: s.quotationId,
      code: 'HT-X2',
      name: '合同 X2',
      terms: [{ title: '付款', content: '30%', amount: 1 }],
    },
    cookieA,
  )
  assert.equal(res2.status, 400)

  const res3 = await postContract(slugA, cookieA, s.quotationId, 'HT-X3', { terms: 'not-an-array' })
  assert.equal(res3.status, 400)
})

test('合同编号重复 → 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `t10-${stamp}`)
  assert.equal((await postContract(slugA, cookieA, s.quotationId, 'HT-DUP')).status, 201)
  const res = await postContract(slugA, cookieA, s.quotationId, 'HT-DUP')
  assert.equal(res.status, 409)
})

test('列表：projectId/status 过滤 + 游标分页不重不漏', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const s = await seedChain(tenantA, `t11-${stamp}`)
  for (const code of ['HT-L1', 'HT-L2', 'HT-L3']) {
    assert.equal((await postContract(slugA, cookieA, s.quotationId, code)).status, 201)
  }
  const signed = await jsonOf(await postContract(slugA, cookieA, s.quotationId, 'HT-L4'))
  await app.call('POST', `/t/${slugA}/api/contracts/${signed.id}/advance`, { to: 'signed' }, cookieA)

  const all = await jsonOf(await app.call('GET', `/t/${slugA}/api/contracts?projectId=${s.projectId}&limit=2`, undefined, cookieA))
  assert.equal(all.items.length, 2)
  assert.ok(all.nextCursor)
  const page2 = await jsonOf(
    await app.call(
      'GET',
      `/t/${slugA}/api/contracts?projectId=${s.projectId}&limit=2&cursor=${all.nextCursor}`,
      undefined,
      cookieA,
    ),
  )
  const ids = [...all.items, ...page2.items].map((/** @type {any} */ x) => x.id)
  assert.equal(ids.length, 4)
  assert.equal(new Set(ids).size, 4)

  const signedList = await jsonOf(
    await app.call('GET', `/t/${slugA}/api/contracts?projectId=${s.projectId}&status=signed`, undefined, cookieA),
  )
  assert.equal(signedList.items.length, 1)
  assert.equal(signedList.items[0].code, 'HT-L4')

  const badStatus = await app.call('GET', `/t/${slugA}/api/contracts?status=nope`, undefined, cookieA)
  assert.equal(badStatus.status, 400)
})
