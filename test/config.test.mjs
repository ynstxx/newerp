import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { close, connect, exec } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { resetCache } from '../svc/config.mjs'

/**
 * 租户级系统设置：「自动生成单据编号」可以关掉。
 * 关掉之后新建单据必须手工填编号，自动编号接口给出可读原因。
 */
const password = 'test-pass-123'
const slug = `cf${Date.now().toString(36)}`
const email = `cf-${randomUUID().slice(0, 8)}@example.com`
/** @type {any} */
let app
/** @type {string} */
let cookie = ''
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
  await createTenant({ requestId: 'test', userId: null }, { slug, name: '设置公司', email, password })
  app = await makeApp()
  cookie = await app.login(email, password)
})

test.after(async () => {
  resetCache()
  if (app) await app.close()
})

const post = async (/** @type {string} */ p, /** @type {unknown} */ b) => {
  const res = await app.call('POST', `/t/${slug}${p}`, b, cookie)
  return { s: res.status, j: await jsonOf(res) }
}
const put = async (/** @type {string} */ p, /** @type {unknown} */ b) => {
  const res = await app.call('PUT', `/t/${slug}${p}`, b, cookie)
  return { s: res.status, j: await jsonOf(res) }
}
const get = async (/** @type {string} */ p) => {
  const res = await app.call('GET', `/t/${slug}${p}`, undefined, cookie)
  return { s: res.status, j: await jsonOf(res) }
}

test('默认开启：不填编号自动生成', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  resetCache()
  const created = await post('/api/parties', { name: '默认自动', partyType: 'customer' })
  assert.equal(created.s, 201, JSON.stringify(created.j))
  assert.match(created.j.code, /^CUS-\d{4}-\d{4}$/)
})

test('关掉之后：不填编号 → 400 并说明原因；填了照常', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const off = await put('/api/configs/code.auto', { value: 'false' })
  assert.equal(off.s, 200, JSON.stringify(off.j))

  const noCode = await post('/api/parties', { name: '手工编号公司', partyType: 'customer' })
  assert.equal(noCode.s, 400)
  assert.match(String(noCode.j.error.details.reason), /已关闭自动编号/)
  assert.equal(noCode.j.error.details.fields.code, 'required')

  const manual = await post('/api/parties', { code: 'my-own-001', name: '手工编号公司', partyType: 'customer' })
  assert.equal(manual.s, 201, JSON.stringify(manual.j))
  assert.equal(manual.j.code, 'MY-OWN-001')

  // 打开回来，自动编号恢复
  assert.equal((await put('/api/configs/code.auto', { value: 'true' })).s, 200)
  const again = await post('/api/parties', { name: '恢复自动', partyType: 'customer' })
  assert.equal(again.s, 201)
  assert.match(again.j.code, /^CUS-\d{4}-\d{4}$/)
})

test('配置项列表带展示元信息；未知键 404；非 bool 值 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const list = await get('/api/configs')
  assert.equal(list.s, 200)
  const row = list.j.items.find((/** @type {any} */ x) => x.key === 'code.auto')
  assert.ok(row, '列表里应有 code.auto')
  assert.equal(row.type, 'bool')
  assert.equal(row.value, 'true')

  assert.equal((await put('/api/configs/nope.nope', { value: 'true' })).s, 404)
  assert.equal((await put('/api/configs/code.auto', { value: 'maybe' })).s, 400)
})

test('权限：普通成员不能改配置（system:config 只有 owner 有）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const email2 = `cf2-${randomUUID().slice(0, 8)}@example.com`
  const inv = (await post('/api/invites', { email: email2, roleCode: 'member' })).j
  const reg = await app.call('POST', '/api/auth/register', { email: email2, password, slug, inviteCode: inv.code })
  assert.equal(reg.status, 201)
  const memberCookie = (reg.headers.getSetCookie?.() ?? []).map((/** @type {string} */ c) => c.split(';')[0]).join('; ')

  const res = await app.call('PUT', `/t/${slug}/api/configs/code.auto`, { value: 'false' }, memberCookie)
  assert.equal(res.status, 403)
  const listRes = await app.call('GET', `/t/${slug}/api/configs`, undefined, memberCookie)
  assert.equal(listRes.status, 403)
})
