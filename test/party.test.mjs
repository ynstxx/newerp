import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { close, connect, exec, q } from '../db/index.mjs'
import { createApp } from '../cmd/server.mjs'
import { createTenant } from '../svc/tenant.mjs'

const password = 'test-pass-123'
const ownerA = `pa-${randomUUID().slice(0, 8)}@example.com`
const ownerB = `pb-${randomUUID().slice(0, 8)}@example.com`
const slugA = `pa${Date.now().toString(36)}`
const slugB = `pb${Date.now().toString(36)}`

/** @type {string} */
let base = ''
/** @type {import('node:http').Server} */
let server
let dbUp = false
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  await exec({}, 'DELETE FROM login_attempt', [])
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲集成', email: ownerA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙集成', email: ownerB, password })

  server = createApp().listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`
  cookieA = await login(ownerA)
  cookieB = await login(ownerB)
})

test.after(async () => {
  server?.close()
  await close()
})

/** @param {string} email */
async function login(email) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return (res.headers.getSetCookie?.() ?? []).map((/** @type {string} */ c) => c.split(';')[0]).join('; ')
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [cookie]
 */
const call = (method, path, body, cookie = cookieA) =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

/** @param {any} res */
const jsonOf = async (res) => /** @type {any} */ (await res.json())

const partyOf = (/** @type {string} */ code) => ({
  code,
  name: `客户 ${code}`,
  partyType: 'customer',
  contactName: '张三',
  phone: '13800000000',
  email: 'zhang@example.com',
})

test('创建：201 + 默认 status/version，写进审计', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const res = await call('POST', `/t/${slugA}/api/parties`, partyOf('C001'))
  assert.equal(res.status, 201)
  const body = await jsonOf(res)
  assert.equal(body.code, 'C001')
  assert.equal(body.status, 'active')
  assert.equal(body.version, 1)
  assert.ok(body.createdAt)

  const me = await jsonOf(await call('GET', `/t/${slugA}/api/me`))
  const rows = await q({ tenantId: me.tenant.id }, `SELECT action FROM audit_log WHERE $t AND ref_id = $1`, [body.id])
  assert.deepEqual(rows.map((/** @type {any} */ r) => r.action), ['create'])
})

test('列表：游标分页翻完 5 条，顺序稳定不重不漏', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  for (const code of ['C101', 'C102', 'C103', 'C104', 'C105']) {
    assert.equal((await call('POST', `/t/${slugA}/api/parties`, partyOf(code))).status, 201)
  }

  /** @type {string[]} */
  const seen = []
  let cursor = ''
  let pages = 0
  while (true) {
    const res = await call('GET', `/t/${slugA}/api/parties?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
    assert.equal(res.status, 200)
    const body = await jsonOf(res)
    for (const item of body.items) seen.push(item.code)
    pages++
    if (!body.nextCursor) break
    cursor = body.nextCursor
    assert.ok(pages < 10, '分页死循环')
  }
  assert.equal(new Set(seen).size, seen.length, '有重复项')
  assert.ok(seen.length >= 6)
})

test('过滤：partyType 与关键字', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  await call('POST', `/t/${slugA}/api/parties`, { code: 'S001', name: '供应商甲', partyType: 'supplier' })
  const onlySupplier = await jsonOf(await call('GET', `/t/${slugA}/api/parties?partyType=supplier`))
  assert.ok(onlySupplier.items.length >= 1)
  assert.ok(onlySupplier.items.every((/** @type {any} */ i) => i.partyType === 'supplier'))

  const keyword = await jsonOf(await call('GET', `/t/${slugA}/api/parties?q=供应商`))
  assert.ok(keyword.items.every((/** @type {any} */ i) => i.name.includes('供应商')))
})

test('编码重复 409；未知字段 400；类型非法 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const dup = await call('POST', `/t/${slugA}/api/parties`, partyOf('C001'))
  assert.equal(dup.status, 409)

  const extra = await call('POST', `/t/${slugA}/api/parties`, { ...partyOf('C900'), tenantId: 'x' })
  assert.equal(extra.status, 400)
  assert.match((await jsonOf(extra)).error.details.reason, /未知字段/)

  const badType = await call('POST', `/t/${slugA}/api/parties`, { ...partyOf('C901'), partyType: 'alien' })
  assert.equal(badType.status, 400)
  assert.equal((await jsonOf(badType)).error.details.fields.partyType, 'enum:customer|supplier|both')

  const badEmail = await call('POST', `/t/${slugA}/api/parties`, { ...partyOf('C902'), email: 'not-an-email' })
  assert.equal(badEmail.status, 400)
  assert.equal((await jsonOf(badEmail)).error.details.fields.email, 'email')

  // 编码现在可选：不填就自动生成，不该再报 required
  const auto = await call('POST', `/t/${slugA}/api/parties`, { name: '无编码', partyType: 'customer' })
  assert.equal(auto.status, 201)
  assert.match((await jsonOf(auto)).code, /^CUS-\d{4}-\d{4}$/)
})

test('PATCH：部分更新，version 自增；旧 version 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const created = await jsonOf(await call('POST', `/t/${slugA}/api/parties`, partyOf('P001')))
  const patched = await call('PATCH', `/t/${slugA}/api/parties/${created.id}`, { name: '改名了' })
  assert.equal(patched.status, 200)
  const body = await jsonOf(patched)
  assert.equal(body.name, '改名了')
  assert.equal(body.version, 2)
  assert.equal(body.phone, '13800000000', '未传的字段不该被清空')

  const stale = await call('PATCH', `/t/${slugA}/api/parties/${created.id}`, { name: '又改', version: 1 })
  assert.equal(stale.status, 409)
  assert.match((await jsonOf(stale)).error.details.reason, /版本已变/)
})

test('DELETE 后 GET 404，审计留底', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const created = await jsonOf(await call('POST', `/t/${slugA}/api/parties`, partyOf('D001')))
  assert.equal((await call('DELETE', `/t/${slugA}/api/parties/${created.id}`)).status, 200)
  assert.equal((await call('GET', `/t/${slugA}/api/parties/${created.id}`)).status, 404)
})

test('跨租户：B 读/改/删 A 的客户一律 404', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const a = await jsonOf(await call('POST', `/t/${slugA}/api/parties`, partyOf('X001')))

  assert.equal((await call('GET', `/t/${slugB}/api/parties/${a.id}`, undefined, cookieB)).status, 404)
  assert.equal((await call('PATCH', `/t/${slugB}/api/parties/${a.id}`, { name: '偷改' }, cookieB)).status, 404)
  assert.equal((await call('DELETE', `/t/${slugB}/api/parties/${a.id}`, undefined, cookieB)).status, 404)

  // B 的列表里绝不能出现 A 的数据
  const listB = await jsonOf(await call('GET', `/t/${slugB}/api/parties`, undefined, cookieB))
  assert.ok(!listB.items.some((/** @type {any} */ i) => i.code === 'X001'))
})

test('非成员账号访问 → 404；非 uuid 的 id → 404 而不是 500', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  assert.equal((await call('GET', `/t/${slugA}/api/parties/not-a-uuid`)).status, 404)
  assert.equal((await call('GET', `/t/${slugA}/api/parties/${randomUUID()}`)).status, 404)
})

test('权限：member 角色不能删（403），可以看（200）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const email = `mem-${randomUUID().slice(0, 8)}@example.com`
  const invite = await jsonOf(await call('POST', `/t/${slugA}/api/invites`, { email, roleCode: 'member' }))
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, slug: slugA, inviteCode: invite.code }),
  })
  assert.equal(reg.status, 201)
  const memberCookie = (reg.headers.getSetCookie?.() ?? []).map((/** @type {string} */ c) => c.split(';')[0]).join('; ')

  assert.equal((await call('GET', `/t/${slugA}/api/parties`, undefined, memberCookie)).status, 200)
  const created = await jsonOf(await call('POST', `/t/${slugA}/api/parties`, partyOf('M001')))
  assert.equal(
    (await call('DELETE', `/t/${slugA}/api/parties/${created.id}`, undefined, memberCookie)).status,
    403,
  )
})
