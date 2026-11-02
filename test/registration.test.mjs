import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { close, connect, exec } from '../db/index.mjs'
import { createApp } from '../cmd/server.mjs'
import * as captcha from '../auth/captcha.mjs'
import { createTenant } from '../svc/tenant.mjs'
import * as settings from '../svc/settings.mjs'
import { canRegister } from '../svc/registration.mjs'

const password = 'test-pass-123'
const slug = `r${Date.now().toString(36)}`
const ownerEmail = `owner-${randomUUID().slice(0, 8)}@example.com`
const ctxStub = { requestId: 'test', userId: null, req: { socket: {} } }

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
  await exec({}, 'DELETE FROM login_attempt', [])
  await createTenant({ requestId: 'test', userId: null }, { slug, name: '注册测试公司', email: ownerEmail, password })
  server = createApp().listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`
})

test.after(async () => {
  server?.close()
  // 配置是全局的，跑完恢复默认，免得污染下一次运行
  if (dbUp) {
    await settings.set(ctxStub, 'registration.mode', 'invite')
    await settings.set(ctxStub, 'registration.captcha', 'none')
    await settings.set(ctxStub, 'registration.require_admin_approval', 'false')
    await settings.set(ctxStub, 'registration.email_domain_whitelist', '')
  }
  await close()
})

/** 每个用例前把模式重置成默认，避免互相污染 */
async function mode(/** @type {string} */ m, /** @type {string} */ captchaKind = 'none') {
  await settings.set(ctxStub, 'registration.mode', m)
  await settings.set(ctxStub, 'registration.captcha', captchaKind)
}

/** @param {string} path @param {unknown} body @param {string} [cookie] */
const post = (path, body, cookie) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })

/** @param {any} res */
const jsonOf = async (res) => /** @type {any} */ (await res.json())
/** @param {any} res */
const cookieOf = (res) => (res.headers.getSetCookie?.() ?? []).map((/** @type {string} */ c) => c.split(';')[0]).join('; ')

test('closed：注册一律 403，register-info 仍可读', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  await mode('closed')
  const info = await fetch(`${base}/api/auth/register-info`)
  assert.equal(info.status, 200)
  assert.equal((await jsonOf(info)).mode, 'closed')

  const res = await post('/api/auth/register', { email: `x${Date.now()}@example.com`, password })
  assert.equal(res.status, 403)
  assert.equal((await jsonOf(res)).error.details.reason, 'registration_closed')
})

test('invite：缺码被拒，有效码可加入并自动登录', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  await mode('invite')

  const noCode = await post('/api/auth/register', { email: `y${Date.now()}@example.com`, password, slug })
  assert.equal(noCode.status, 403)
  assert.equal((await jsonOf(noCode)).error.details.reason, 'invite_required')

  // owner 登录后发邀请
  const owner = cookieOf(await post('/api/auth/login', { email: ownerEmail, password }))
  const invitee = `inv-${randomUUID().slice(0, 8)}@example.com`
  const made = await post(`/t/${slug}/api/invites`, { email: invitee, roleCode: 'member' }, owner)
  assert.equal(made.status, 201)
  const invite = await jsonOf(made)
  assert.match(invite.url, new RegExp(`^/t/${slug}/join\\?code=`))

  // 别用别人的邮箱不行
  const wrongEmail = await post('/api/auth/register', {
    email: `other-${randomUUID().slice(0, 8)}@example.com`,
    password,
    slug,
    inviteCode: invite.code,
  })
  assert.equal(wrongEmail.status, 400)
  assert.equal((await jsonOf(wrongEmail)).error.details.reason, 'invite_invalid')

  const ok = await post('/api/auth/register', { email: invitee, password, slug, inviteCode: invite.code })
  assert.equal(ok.status, 201)
  assert.deepEqual((await jsonOf(ok)).tenant, { slug })
  const cookie = cookieOf(ok)
  assert.match(cookie, /^sid=/)

  // 自动登录后能看到自己是以 member 身份进来的
  const me = await jsonOf(await fetch(`${base}/t/${slug}/api/me`, { headers: { cookie } }))
  assert.equal(me.role.code, 'member')

  // 同一个码不能再用第二次
  const again = await post('/api/auth/register', {
    email: `third-${randomUUID().slice(0, 8)}@example.com`,
    password,
    slug,
    inviteCode: invite.code,
  })
  assert.equal(again.status, 400)
})

test('email/open：自助建公司，slug 自动分配且不重复', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  await mode('email')
  const email = `self-${randomUUID().slice(0, 8)}@example.com`
  const res = await post('/api/auth/register', { email, password, displayName: '自建' })
  assert.equal(res.status, 201)
  const body = await jsonOf(res)
  assert.ok(body.tenant.slug)

  const me = await jsonOf(await fetch(`${base}/t/${body.tenant.slug}/api/me`, { headers: { cookie: cookieOf(res) } }))
  assert.equal(me.role.code, 'owner')
  assert.match(me.tenant.name, /自建的公司$/)
})

test('open + math 人机校验：缺答案 400，答对通过', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  await mode('open', 'math')
  const info = await jsonOf(await fetch(`${base}/api/auth/register-info`))
  assert.equal(info.captcha, 'math')
  assert.ok(info.challenge.token)
  assert.match(info.challenge.question, /^\d \+ \d = \?$/)

  const email = `cap-${randomUUID().slice(0, 8)}@example.com`
  const noAnswer = await post('/api/auth/register', { email, password })
  assert.equal(noAnswer.status, 400)
  assert.equal((await jsonOf(noAnswer)).error.details.reason, '人机校验未通过')

  const m = /(\d+) \+ (\d+)/.exec(info.challenge.question)
  assert.ok(m)
  const answer = Number(m[1]) + Number(m[2])
  const ok = await post('/api/auth/register', {
    email,
    password,
    captchaToken: info.challenge.token,
    captchaAnswer: answer,
  })
  assert.equal(ok.status, 201)
})

test('require_admin_approval：建号后 pending，登录被拒，CLI 类接口放行后才可登', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  await mode('open')
  await settings.set(ctxStub, 'registration.require_admin_approval', 'true')
  const email = `pend-${randomUUID().slice(0, 8)}@example.com`

  const res = await post('/api/auth/register', { email, password })
  assert.equal(res.status, 202)
  assert.equal((await jsonOf(res)).pending, true)
  assert.equal(cookieOf(res), '', '待放行不应发会话')

  assert.equal((await post('/api/auth/login', { email, password })).status, 401)

  // M0 没有管理后台，放行走 CLI 同一个 store 函数（cmd/user.mjs approve）
  const users = await import('../store/user.mjs')
  await users.setStatus(ctxStub, email, 'active')
  assert.equal((await post('/api/auth/login', { email, password })).status, 200)

  await settings.set(ctxStub, 'registration.require_admin_approval', 'false')
})

test('邮箱域名白名单：不在名单内 403', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  await mode('email')
  await settings.set(ctxStub, 'registration.email_domain_whitelist', '*.gov.cn,acme.com')
  assert.equal((await canRegister(ctxStub, { email: 'a@city.gov.cn' })).ok, true)
  assert.equal((await canRegister(ctxStub, { email: 'a@acme.com' })).ok, true)
  const bad = await canRegister(ctxStub, { email: 'a@evil.com' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'email_domain_not_allowed')

  await settings.set(ctxStub, 'registration.email_domain_whitelist', '')
})

test('配置 30 秒缓存：改库后本进程 set 立即失效，外部改库最多 30s', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  await mode('closed')
  assert.equal(await settings.get(ctxStub, 'registration.mode'), 'closed')

  // 绕过 svc 直接改库 → 命中缓存，仍旧是旧值
  const { put } = await import('../store/settings.mjs')
  await put(ctxStub, 'registration.mode', 'open')
  assert.equal(await settings.get(ctxStub, 'registration.mode'), 'closed', '30s 内应仍读到缓存')

  // 走 svc 写 → 立即失效
  await settings.set(ctxStub, 'registration.mode', 'invite')
  assert.equal(await settings.get(ctxStub, 'registration.mode'), 'invite')
})

test('captcha token 篡改或过期都算失败', () => {
  const { token } = captcha.issue()
  const parts = token.split('.')
  assert.equal(captcha.verify(`${parts[0]}.${parts[1]}.AAAA`, 5), false)
  assert.equal(captcha.verify(token.replace('+', '-'), 5), false)
  assert.equal(captcha.verify(token, undefined), false)
  assert.equal(captcha.verify(undefined, 5), false)
})
