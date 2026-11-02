import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { makeApp, jsonOf } from './helpers.mjs'
import { register } from '../api/routes-a.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { close, connect } from '../db/index.mjs'

const password = 'test-pass-123'
// 同一个库会反复跑：所有业务编码都带 run 后缀，避免撞历史数据
const run = randomUUID().slice(0, 8)
const ownerA = `a-${run}@example.com`
const ownerB = `b-${run}@example.com`
const slugA = `a${run}`
const slugB = `b${run}`

/** @type {any} */
let app
let dbUp = false
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''
/** @type {string} */
let cookieMember = ''
/** @type {string} */
let partyA = ''

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  app = await makeApp(register)
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲集成', email: ownerA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙集成', email: ownerB, password })
  cookieA = await app.login(ownerA, password)
  cookieB = await app.login(ownerB, password)

  const party = await jsonOf(
    await call('POST', `/t/${slugA}/api/parties`, { code: `C-${run}`, name: '甲客户', partyType: 'customer' }),
  )
  partyA = party.id

  // member 角色账号：用来验证 terminated 只有 owner 能做
  const email = `m-${run}@example.com`
  const invite = await jsonOf(await call('POST', `/t/${slugA}/api/invites`, { email, roleCode: 'member' }))
  const reg = await fetch(`${app.base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, slug: slugA, inviteCode: invite.code }),
  })
  assert.equal(reg.status, 201)
  cookieMember = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
})

test.after(async () => {
  await app?.close()
  await close()
})

/**
 * @param {string} method
 * @param {string} path 已含 /t/{slug} 前缀
 * @param {unknown} [body]
 * @param {string} [cookie]
 */
const call = (method, path, body, cookie = cookieA) => app.call(method, path, body, cookie)

/** @param {string} code */
const oppOf = (code) => ({
  code,
  name: `商机 ${code}`,
  partyId: partyA,
  estAmount: '120000.00',
  expectedSignAt: '2026-06-30',
  note: '初次接洽',
})

/**
 * 造前置数据：商机 → following → won，拿到生成的 project(draft)
 * @param {string} code
 * @param {string} [cookie]
 */
async function makeProject(code, cookie = cookieA) {
  const opp = await jsonOf(await call('POST', `/t/${slugA}/api/opportunities`, oppOf(code), cookie))
  assert.equal(opp.stage, 'new')
  await call('POST', `/t/${slugA}/api/opportunities/${opp.id}/advance`, { to: 'following' }, cookie)
  const won = await jsonOf(await call('POST', `/t/${slugA}/api/opportunities/${opp.id}/advance`, { to: 'won' }, cookie))
  assert.ok(won.project, 'won 应生成 project')
  return { opp, project: won.project }
}

// ---------------------------------------------------------------- 正常链路

test('商机 new→following→won：同事务生成 project(draft) 与第一条 stage_log', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const created = await call('POST', `/t/${slugA}/api/opportunities`, oppOf(`O-${run}-1`))
  assert.equal(created.status, 201)
  const opp = await jsonOf(created)
  assert.equal(opp.stage, 'new')
  assert.equal(opp.version, 1)
  assert.equal(Number(opp.estAmount), 120000)
  assert.ok(opp.expectedSignAt)

  const following = await jsonOf(
    await call('POST', `/t/${slugA}/api/opportunities/${opp.id}/advance`, { to: 'following' }),
  )
  assert.equal(following.stage, 'following')
  assert.equal(following.project, null, 'following 不该建项目')

  const wonRes = await call('POST', `/t/${slugA}/api/opportunities/${opp.id}/advance`, { to: 'won', note: '中标' })
  assert.equal(wonRes.status, 200)
  const won = await jsonOf(wonRes)
  assert.equal(won.stage, 'won')
  assert.equal(won.project.status, 'draft')
  assert.equal(won.project.code, `P-O-${run}-1`.toUpperCase())
  assert.equal(won.project.opportunityId, opp.id)
  assert.equal(won.project.partyId, partyA)
  assert.equal(Number(won.project.contractAmt), 0)

  const logs = await jsonOf(await call('GET', `/t/${slugA}/api/projects/${won.project.id}/stages`))
  assert.equal(logs.items.length, 1)
  assert.equal(logs.items[0].fromStatus, null)
  assert.equal(logs.items[0].toStatus, 'draft')
  assert.equal(logs.items[0].actorId, opp.ownerId ?? logs.items[0].actorId)

  // won 是终态
  assert.equal((await call('POST', `/t/${slugA}/api/opportunities/${opp.id}/advance`, { to: 'lost' })).status, 409)
})

test('非法跳转一律 409，错误体带 allowed', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const opp = await jsonOf(await call('POST', `/t/${slugA}/api/opportunities`, oppOf(`O-${run}-2`)))
  const bad = await call('POST', `/t/${slugA}/api/opportunities/${opp.id}/advance`, { to: 'won' })
  assert.equal(bad.status, 409)
  const body = await jsonOf(bad)
  assert.match(body.error.details.reason, /不允许/)
  assert.deepEqual(body.error.details.allowed, ['following', 'lost'])
  // 状态没被改
  assert.equal((await jsonOf(await call('GET', `/t/${slugA}/api/opportunities/${opp.id}`))).stage, 'new')

  const { project } = await makeProject(`O-${run}-2b`)
  // draft 不能直接跳 designing
  const badProject = await call('POST', `/t/${slugA}/api/projects/${project.id}/advance`, { to: 'designing' })
  assert.equal(badProject.status, 409)
  assert.deepEqual((await jsonOf(badProject)).error.details.allowed, ['approved', 'terminated'])

  // signed 只能由合同签署推进，这里提前拦住（不然零合同也算已签约）
  const badSigned = await call('POST', `/t/${slugA}/api/projects/${project.id}/advance`, { to: 'signed' })
  assert.equal(badSigned.status, 409)
  assert.match((await jsonOf(badSigned)).error.details.reason, /只能由合同签署推进/)
})

test('项目 draft→approved→designing→quoting 正常推进，stage_log 逐条累积', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const { project } = await makeProject(`O-${run}-3`)
  // signed 不在这里测：它只能由合同签署联动产生（见 test/m1_chain.test.mjs）
  const chain = ['approved', 'designing', 'quoting']
  for (const to of chain) {
    const res = await call('POST', `/t/${slugA}/api/projects/${project.id}/advance`, { to, note: `推进 ${to}` })
    assert.equal(res.status, 200, `推进到 ${to} 失败`)
    const body = await jsonOf(res)
    assert.equal(body.status, to)
    assert.equal(body.version, 2 + chain.indexOf(to))
  }

  const logs = await jsonOf(await call('GET', `/t/${slugA}/api/projects/${project.id}/stages`))
  assert.equal(logs.items.length, 4)
  assert.deepEqual(
    logs.items.map((/** @type {any} */ l) => [l.fromStatus, l.toStatus]),
    [
      [null, 'draft'],
      ['draft', 'approved'],
      ['approved', 'designing'],
      ['designing', 'quoting'],
    ],
  )
  assert.ok(logs.items.every((/** @type {any} */ l) => l.actorId))

  // 状态推进后过滤能命中
  const quoting = await jsonOf(await call('GET', `/t/${slugA}/api/projects?status=quoting&q=O-${run}-3`))
  assert.ok(quoting.items.some((/** @type {any} */ p) => p.id === project.id))
  const drafts = await jsonOf(await call('GET', `/t/${slugA}/api/projects?status=draft&q=O-${run}-3`))
  assert.ok(!drafts.items.some((/** @type {any} */ p) => p.id === project.id))
})

test('terminated 只有 owner 能做：member 403，owner 200', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const { project } = await makeProject(`O-${run}-4`, cookieMember)

  const denied = await call('POST', `/t/${slugA}/api/projects/${project.id}/advance`, { to: 'terminated' }, cookieMember)
  assert.equal(denied.status, 403)
  assert.equal((await jsonOf(denied)).error.details.need, 'project:terminate')
  assert.equal((await jsonOf(await call('GET', `/t/${slugA}/api/projects/${project.id}`))).status, 'draft')

  // 普通的推进 member 是允许的
  assert.equal(
    (await call('POST', `/t/${slugA}/api/projects/${project.id}/advance`, { to: 'approved' }, cookieMember)).status,
    200,
  )

  const done = await call('POST', `/t/${slugA}/api/projects/${project.id}/advance`, { to: 'terminated' })
  assert.equal(done.status, 200)
  assert.equal((await jsonOf(done)).status, 'terminated')

  // terminated 是终态
  assert.equal((await call('POST', `/t/${slugA}/api/projects/${project.id}/advance`, { to: 'approved' })).status, 409)
  const logs = await jsonOf(await call('GET', `/t/${slugA}/api/projects/${project.id}/stages`))
  assert.equal(logs.items.at(-1).toStatus, 'terminated')
})

// ---------------------------------------------------------------- 隔离与校验

test('跨租户：B 读/改/推进 A 的商机与项目一律 404，B 的列表不含 A 的数据', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const { opp, project } = await makeProject(`O-${run}-5`)

  const oppPaths = [
    ['GET', `/t/${slugB}/api/opportunities/${opp.id}`, undefined],
    ['PATCH', `/t/${slugB}/api/opportunities/${opp.id}`, { name: '偷改' }],
    ['POST', `/t/${slugB}/api/opportunities/${opp.id}/advance`, { to: 'lost' }],
  ]
  for (const [method, path, body] of oppPaths) {
    const res = await call(String(method), String(path), body, cookieB)
    assert.equal(res.status, 404, `${method} ${path} 应 404`)
  }

  const projectPaths = [
    ['GET', `/t/${slugB}/api/projects/${project.id}`, undefined],
    ['PATCH', `/t/${slugB}/api/projects/${project.id}`, { name: '偷改' }],
    ['POST', `/t/${slugB}/api/projects/${project.id}/advance`, { to: 'approved' }],
    ['GET', `/t/${slugB}/api/projects/${project.id}/stages`, undefined],
  ]
  for (const [method, path, body] of projectPaths) {
    const res = await call(String(method), String(path), body, cookieB)
    assert.equal(res.status, 404, `${method} ${path} 应 404`)
  }

  const listOppB = await jsonOf(await call('GET', `/t/${slugB}/api/opportunities?limit=100`, undefined, cookieB))
  assert.ok(!listOppB.items.some((/** @type {any} */ o) => o.code === opp.code))
  const listProjB = await jsonOf(await call('GET', `/t/${slugB}/api/projects?limit=100`, undefined, cookieB))
  assert.ok(!listProjB.items.some((/** @type {any} */ p) => p.id === project.id))

  // 拿 A 的客户 id 在 B 建商机 → 404（越权即不存在，不能靠 400 泄漏存在性）
  const crossed = await call('POST', `/t/${slugB}/api/opportunities`, { ...oppOf(`O-${run}-5x`), partyId: partyA }, cookieB)
  assert.equal(crossed.status, 404)

  // 不存在 / 非 uuid 的 id 都当 404
  assert.equal((await call('GET', `/t/${slugA}/api/opportunities/not-a-uuid`)).status, 404)
  assert.equal((await call('GET', `/t/${slugA}/api/projects/${randomUUID()}`)).status, 404)
})

test('跨租户用户引用：ownerId / pmUserId 必须是本公司成员', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  // B 的 owner 用户 id（全局表 auth_user 里真实存在，复合外键管不到）
  const meB = await jsonOf(await call('GET', `/t/${slugB}/api/me`, undefined, cookieB))
  const foreignUserId = meB.user.id

  const reject = await call('POST', `/t/${slugA}/api/opportunities`, {
    ...oppOf(`O-${run}-9`),
    ownerId: foreignUserId,
  })
  assert.equal(reject.status, 400)
  assert.equal((await jsonOf(reject)).error.details.fields.ownerId, 'not_member')

  const { project } = await makeProject(`O-${run}-9b`)
  const badPm = await call('PATCH', `/t/${slugA}/api/projects/${project.id}`, {
    pmUserId: foreignUserId,
    version: project.version,
  })
  assert.equal(badPm.status, 400)
  assert.equal((await jsonOf(badPm)).error.details.fields.pmUserId, 'not_member')
})

test('未知字段 / 缺失 / 非法金额 / 非法日期 / 未知目标 → 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const extra = await call('POST', `/t/${slugA}/api/opportunities`, { ...oppOf(`O-${run}-6`), tenantId: 'x' })
  assert.equal(extra.status, 400)
  assert.match((await jsonOf(extra)).error.details.reason, /未知字段/)

  const missing = await call('POST', `/t/${slugA}/api/opportunities`, {
    code: `O-${run}-6m`,
    name: '缺金额',
    partyId: partyA,
  })
  assert.equal(missing.status, 400)
  assert.equal((await jsonOf(missing)).error.details.fields.estAmount, 'required')

  const badMoney = await call('POST', `/t/${slugA}/api/opportunities`, { ...oppOf(`O-${run}-6b`), estAmount: 'abc' })
  assert.equal(badMoney.status, 400)
  assert.equal((await jsonOf(badMoney)).error.details.fields.estAmount, 'money')

  const badDate = await call('POST', `/t/${slugA}/api/opportunities`, {
    ...oppOf(`O-${run}-6d`),
    expectedSignAt: 'not-a-date',
  })
  assert.equal(badDate.status, 400)
  assert.equal((await jsonOf(badDate)).error.details.fields.expectedSignAt, 'date')

  const opp = await jsonOf(await call('POST', `/t/${slugA}/api/opportunities`, oppOf(`O-${run}-6e`)))
  const badTarget = await call('POST', `/t/${slugA}/api/opportunities/${opp.id}/advance`, { to: 'nope' })
  assert.equal(badTarget.status, 400)

  const { project } = await makeProject(`O-${run}-6p`)
  const badPatch = await call('PATCH', `/t/${slugA}/api/projects/${project.id}`, { status: 'signed' })
  assert.equal(badPatch.status, 400)
  assert.match((await jsonOf(badPatch)).error.details.reason, /未知字段/)
})

test('PATCH：部分更新 + version 自增，旧 version 409，编码重复 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const opp = await jsonOf(await call('POST', `/t/${slugA}/api/opportunities`, oppOf(`O-${run}-7`)))
  const patched = await call(
    'PATCH',
    `/t/${slugA}/api/opportunities/${opp.id}`,
    { name: '改名了', estAmount: 98000.5, expectedSignAt: '2026-09-30', version: 1 },
  )
  assert.equal(patched.status, 200)
  const body = await jsonOf(patched)
  assert.equal(body.name, '改名了')
  assert.equal(body.version, 2)
  assert.equal(Number(body.estAmount), 98000.5)
  assert.equal(body.partyId, partyA, '未传的字段不该被清空')
  assert.match(body.expectedSignAt, /^2026-09-30/)

  const stale = await call('PATCH', `/t/${slugA}/api/opportunities/${opp.id}`, { name: '又改', version: 1 })
  assert.equal(stale.status, 409)
  assert.match((await jsonOf(stale)).error.details.reason, /版本已变/)

  const dup = await call('POST', `/t/${slugA}/api/opportunities`, oppOf(`O-${run}-7`))
  assert.equal(dup.status, 409)

  // 项目 PATCH：名字 / 项目经理 / 起止日期
  const { project } = await makeProject(`O-${run}-7p`)
  const meA = await jsonOf(await call('GET', `/t/${slugA}/api/me`))
  const pj = await call('PATCH', `/t/${slugA}/api/projects/${project.id}`, {
    name: '项目改名',
    pmUserId: meA.user.id,
    startDate: '2026-07-01',
    endDate: '2026-12-31',
    version: project.version,
  })
  assert.equal(pj.status, 200)
  const pjBody = await jsonOf(pj)
  assert.equal(pjBody.name, '项目改名')
  assert.equal(pjBody.version, project.version + 1)
  assert.match(pjBody.startDate, /^2026-07-01/)

  const pjStale = await call('PATCH', `/t/${slugA}/api/projects/${project.id}`, {
    name: '再改',
    version: project.version,
  })
  assert.equal(pjStale.status, 409)
})

test('列表：游标分页翻完，stage/q 过滤生效', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  for (const suffix of ['a', 'b', 'c']) await makeProject(`L-${run}-${suffix}`)

  /** @type {string[]} */
  const seen = []
  let cursor = ''
  let pages = 0
  while (true) {
    const qs = `limit=2&q=${encodeURIComponent(`L-${run}-`)}${cursor ? `&cursor=${cursor}` : ''}`
    const res = await call('GET', `/t/${slugA}/api/projects?${qs}`)
    assert.equal(res.status, 200)
    const body = await jsonOf(res)
    for (const item of body.items) seen.push(item.code)
    pages++
    if (!body.nextCursor) break
    cursor = body.nextCursor
    assert.ok(pages < 10, '分页死循环')
  }
  assert.equal(new Set(seen).size, seen.length, '有重复项')
  assert.equal(seen.length, 3)
  assert.ok(seen.every((/** @type {string} */ c) => c.startsWith(`P-L-${run}-`.toUpperCase())))

  const wonOnly = await jsonOf(await call('GET', `/t/${slugA}/api/opportunities?stage=won&limit=100`))
  assert.ok(wonOnly.items.length >= 3)
  assert.ok(wonOnly.items.every((/** @type {any} */ o) => o.stage === 'won'))
})
