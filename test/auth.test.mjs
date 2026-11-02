import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { close, connect, exec } from '../db/index.mjs'
import { createApp } from '../cmd/server.mjs'
import { createTenant } from '../svc/tenant.mjs'

const password = 'test-pass-123'
const emailA = `a-${randomUUID().slice(0, 8)}@example.com`
const emailB = `b-${randomUUID().slice(0, 8)}@example.com`
const slugA = `a${Date.now().toString(36)}`
const slugB = `b${Date.now().toString(36)}`

/** @type {string} */
let base = ''
/** @type {import('node:http').Server} */
let server
let dbUp = false

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  // 登录限流按 IP 计数（20 次/小时），跨轮跑会累积 —— 测试前清空，否则用例不可重入
  await exec({}, 'DELETE FROM login_attempt', [])
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '公司A', email: emailA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '公司B', email: emailB, password })
  server = createApp().listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`
})

test.after(async () => {
  server?.close()
  await close()
})

/**
 * @param {string} path
 * @param {unknown} body
 * @param {string} [cookie]
 */
const post = (path, body, cookie) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })

/** @param {any} res */
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((/** @type {string} */ c) => c.split(';')[0]).join('; ')
/** @param {any} res */
const setCookieRaw = (res) => (res.headers.getSetCookie?.() ?? []).join(' | ')
/** @param {any} res */
const jsonOf = async (res) => /** @type {any} */ (await res.json())

test('登录：正确密码发会话 cookie，错误密码 401', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const ok = await post('/api/auth/login', { email: emailA, password })
  assert.equal(ok.status, 200)
  const cookie = cookieOf(ok)
  assert.match(cookie, /^sid=/)
  assert.equal((await jsonOf(ok)).user.email, emailA)

  const bad = await post('/api/auth/login', { email: emailA, password: 'wrong-pass' })
  assert.equal(bad.status, 401)
  assert.equal((await jsonOf(bad)).error.code, 'unauthorized')
})

test('/api/me 无 cookie → 401；有 cookie → 用户 + 公司列表', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  assert.equal((await fetch(`${base}/api/me`)).status, 401)

  const login = await post('/api/auth/login', { email: emailA, password })
  const cookie = cookieOf(login)
  const me = await fetch(`${base}/api/me`, { headers: { cookie } })
  assert.equal(me.status, 200)
  const body = await jsonOf(me)
  assert.equal(body.user.email, emailA)
  assert.deepEqual(body.tenants, [{ slug: slugA, name: '公司A', role: 'owner' }])
})

test('租户作用域 /t/{slug}/api/me：带角色与权限点', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const cookie = cookieOf(await post('/api/auth/login', { email: emailA, password }))
  const res = await fetch(`${base}/t/${slugA}/api/me`, { headers: { cookie } })
  assert.equal(res.status, 200)
  const body = await jsonOf(res)
  assert.equal(body.tenant.slug, slugA)
  assert.equal(body.role.code, 'owner')
  assert.deepEqual(body.perms, ['*'])
})

test('跨租户越权：B 的凭证读 A 的公司 → 404（不是 403）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const cookieB = cookieOf(await post('/api/auth/login', { email: emailB, password }))
  const res = await fetch(`${base}/t/${slugA}/api/me`, { headers: { cookie: cookieB } })
  assert.equal(res.status, 404)
  assert.equal((await jsonOf(res)).error.code, 'not_found')

  // 不存在的公司同样 404，两者不可区分
  const ghost = await fetch(`${base}/t/nope-nope/api/me`, { headers: { cookie: cookieB } })
  assert.equal(ghost.status, 404)
})

test('未登录访问租户路径 → 401', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const res = await fetch(`${base}/t/${slugA}/api/me`)
  assert.equal(res.status, 401)
})

test('登出后会话立即失效', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const cookie = cookieOf(await post('/api/auth/login', { email: emailA, password }))
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 200)

  const out = await post('/api/auth/logout', {}, cookie)
  assert.equal(out.status, 200)
  assert.match(setCookieRaw(out), /Max-Age=0/)
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401)
})

test('登录失败 5 次后锁定（第 6 次 429）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const email = `lock-${randomUUID().slice(0, 8)}@example.com`
  for (let i = 0; i < 5; i++) {
    assert.equal((await post('/api/auth/login', { email, password: 'x' })).status, 401)
  }
  const locked = await post('/api/auth/login', { email, password: 'x' })
  assert.equal(locked.status, 429)
  assert.equal((await jsonOf(locked)).error.code, 'too_many_requests')
})

test('建租户：slug 重复 409，未知字段 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  await assert.rejects(
    () => createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '重复', email: 'x@y.z', password }),
    (/** @type {any} */ err) => /已被占用/.test(err.details?.reason ?? ''),
  )
  const res = await post('/api/auth/login', { email: emailA, password, tenantId: 'fake' })
  assert.equal(res.status, 400)
  assert.match((await jsonOf(res)).error.details.reason, /未知字段/)
})
