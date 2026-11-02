import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createHmac, randomUUID } from 'node:crypto'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { close, connect, one, q } from '../db/index.mjs'
import { decrypt } from '../svc/integration_crypto.mjs'
import { clearFetchBaseUrl, setFetchBaseUrl } from '../svc/integration_providers.mjs'
import { sendText } from '../svc/integration_webhook.mjs'

const password = 'test-pass-123'
const run = randomUUID().slice(0, 8)
const ownerA = `ia-${run}@example.com`
const ownerB = `ib-${run}@example.com`
const slugA = `ia${run}`
const slugB = `ib${run}`

/** @type {any} */
let app
let dbUp = false
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''
/** @type {any} */
let tenantA
/** @type {string} */
let connA = ''
/** @type {string} */
let base = ''

const secrets = {
  appkey: 'ding-app-key',
  appsecret: 'ding-app-secret',
  webhook_url: '',
  webhook_secret: 'webhook-secret',
}

/** @type {any} */
const fake = {
  departments: [
    { id: 1, name: '总经办', parentid: 0 },
    { id: 2, name: '研发部', parentid: 1 },
  ],
  users: {
    1: [
      { userid: 'dt-1', name: '张三', mobile: '13800000001', email: `dt1-${run}@example.com`, active: true },
      { userid: 'dt-2', name: '李四', mobile: '13800000002', email: `dt2-${run}@example.com`, active: true },
    ],
    2: [
      { userid: 'dt-3', name: '王五', mobile: '13800000003', email: `dt3-${run}@example.com`, active: true },
      { userid: 'dt-4', name: '赵六', mobile: '13800000004', email: `dt4-${run}@example.com`, active: true },
      // 故意不给邮箱：必须走 <=64 字符的 fallback，不能炸掉整个同步事务
      { userid: 'dt-5', name: '孙七', mobile: '13800000005', active: true },
    ],
  },
  oauth: { 'oauth-ok': 'dt-1', 'oauth-ghost': 'dt-ghost' },
  /** @type {{ method: string, path: string, query: Record<string, string>, body: any }[]} */
  requests: [],
}

/** @type {import('node:http').Server} */
let fakeServer

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function reply(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) })
  res.end(json)
}

async function startFake() {
  fakeServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    /** @type {Buffer[]} */
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    /** @type {any} */
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = raw
    }
    fake.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
    })

    if (url.pathname === '/gettoken') return reply(res, 200, { errcode: 0, access_token: 'dt-token' })
    if (url.pathname === '/department/list') return reply(res, 200, { errcode: 0, department: fake.departments })
    if (url.pathname === '/user/list') {
      const dept = url.searchParams.get('department_id') ?? ''
      return reply(res, 200, { errcode: 0, userlist: fake.users[dept] ?? [] })
    }
    if (url.pathname === '/topapi/v2/user/getuserinfo') {
      const userid = fake.oauth[body?.code]
      if (!userid) return reply(res, 200, { errcode: 0, result: {} })
      return reply(res, 200, { errcode: 0, result: { userid } })
    }
    if (url.pathname === '/cgi-bin/webhook/send' || url.pathname === '/robot/send') {
      return reply(res, 200, { errcode: 0, errmsg: 'ok' })
    }
    return reply(res, 404, { errcode: 404, errmsg: `fake 未实现 ${url.pathname}` })
  })
  fakeServer.listen(0, '127.0.0.1')
  await once(fakeServer, 'listening')
  const addr = /** @type {import('node:net').AddressInfo} */ (fakeServer.address())
  return `http://127.0.0.1:${addr.port}`
}

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }

  base = await startFake()
  setFetchBaseUrl('dingtalk', base)
  setFetchBaseUrl('wecom', base)

  app = await makeApp()
  tenantA = await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲集成', email: ownerA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙集成', email: ownerB, password })
  cookieA = await app.login(ownerA, password)
  cookieB = await app.login(ownerB, password)

  secrets.webhook_url = `${base}/robot/send`
  const created = await app.call(
    'POST',
    `/t/${slugA}/api/integrations`,
    { provider: 'dingtalk', corpId: 'corp-a', agentId: 'agent-a', secrets, enabled: true },
    cookieA,
  )
  assert.equal(created.status, 201)
  connA = (await jsonOf(created)).id
})

test.after(async () => {
  clearFetchBaseUrl()
  fakeServer?.close()
  await app?.close()
  await close()
})

/** @param {string} method @param {string} path @param {unknown} [body] @param {string} [cookie] */
const call = (method, path, body, cookie = cookieA) => app.call(method, path, body, cookie)

const tenantCtxA = () => ({ tenantId: tenantA.tenantId })

/** @param {string} provider @param {string} type */
async function mapsOf(provider, type) {
  return q(
    tenantCtxA(),
    `SELECT external_id, local_id FROM integration_map WHERE $t AND provider = $1 AND external_type = $2`,
    [provider, type],
  )
}

test('同步：2 部门 / 5 人 → 5 条 org_membership + map，counts 正确', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const res = await call('POST', `/t/${slugA}/api/integrations/${connA}/sync`)
  assert.equal(res.status, 200)
  const body = await jsonOf(res)
  assert.deepEqual(body.counts, { depts: 2, users: 5, created: 5, updated: 0, disabled: 0, failed: 0 })

  const userMaps = await mapsOf('dingtalk', 'user')
  const deptMaps = await mapsOf('dingtalk', 'dept')
  assert.equal(userMaps.length, 5)
  assert.equal(deptMaps.length, 2)
  assert.deepEqual(userMaps.map((/** @type {any} */ m) => m.external_id).sort(), [
    'dt-1',
    'dt-2',
    'dt-3',
    'dt-4',
    'dt-5',
  ])

  const members = await q(tenantCtxA(), `SELECT user_id, status FROM org_membership WHERE $t`, [])
  assert.equal(members.length, 6, 'owner + 5 个同步成员')
  const byUser = new Map(members.map((/** @type {any} */ m) => [m.user_id, m.status]))
  for (const m of userMaps) assert.equal(byUser.get(m.local_id), 'active')

  const noEmail = userMaps.find((/** @type {any} */ m) => m.external_id === 'dt-5')
  const fallback = await one({}, `SELECT email FROM auth_user WHERE id = $1`, [noEmail.local_id])
  assert.ok(fallback.email.endsWith('@dingtalk.local'))
  assert.ok(fallback.email.length <= 64)

  const logs = await jsonOf(await call('GET', `/t/${slugA}/api/integrations/${connA}/logs`))
  assert.equal(logs.items.length, 1)
  assert.deepEqual(logs.items[0].counts, body.counts)
  assert.equal(logs.items[0].error, null)
})

test('重跑不重复建人：user 数量不变，updated > 0', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const before = await mapsOf('dingtalk', 'user')
  const res = await call('POST', `/t/${slugA}/api/integrations/${connA}/sync`)
  assert.equal(res.status, 200)
  const body = await jsonOf(res)
  assert.equal(body.counts.users, 5)
  assert.equal(body.counts.created, 0)
  assert.ok(body.counts.updated > 0)

  const after = await mapsOf('dingtalk', 'user')
  assert.equal(after.length, before.length)
  assert.deepEqual(after.map((/** @type {any} */ m) => m.local_id).sort(), before.map((/** @type {any} */ m) => m.local_id).sort())
  const members = await q(tenantCtxA(), `SELECT user_id FROM org_membership WHERE $t`, [])
  assert.equal(members.length, 6, '第二次同步不能多出成员')
})

test('外部停用一人 → membership disabled，auth_user 仍保留', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  fake.users[2][1].active = false // dt-4
  const res = await call('POST', `/t/${slugA}/api/integrations/${connA}/sync`)
  assert.equal(res.status, 200)
  const body = await jsonOf(res)
  assert.equal(body.counts.disabled, 1)
  assert.equal(body.counts.users, 5)

  const map = (await mapsOf('dingtalk', 'user')).find((/** @type {any} */ m) => m.external_id === 'dt-4')
  assert.ok(map)
  const mem = await one(tenantCtxA(), `SELECT status FROM org_membership WHERE $t AND user_id = $1`, [map.local_id])
  assert.equal(mem.status, 'disabled')
  const user = await one({}, `SELECT id FROM auth_user WHERE id = $1`, [map.local_id])
  assert.ok(user, '历史单据要留人，auth_user 不能物理删')
})

test('密钥：列表只回 configured，库里是密文且不等于明文', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const list = await jsonOf(await call('GET', `/t/${slugA}/api/integrations`))
  const conn = list.items.find((/** @type {any} */ c) => c.id === connA)
  assert.deepEqual(conn.secrets, { configured: true })
  assert.ok(!JSON.stringify(conn).includes('ding-app-secret'))

  const row = await one(tenantCtxA(), `SELECT secrets FROM integration_conn WHERE $t AND id = $1`, [connA])
  assert.equal(typeof row.secrets, 'string')
  assert.notEqual(row.secrets, JSON.stringify(secrets))
  assert.ok(!row.secrets.includes('ding-app-secret'))
  assert.equal(JSON.parse(decrypt(row.secrets)).appsecret, 'ding-app-secret')
  assert.throws(() => decrypt(`${row.secrets}x`), /解密失败|格式无效/)
})

test('扫码登录：命中 map → 302 + 会话 cookie；未命中 → 明确报错且不建号', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const auth = await jsonOf(await call('GET', `/t/${slugA}/api/integrations/${connA}/auth-url`))
  assert.match(auth.url, /login\.dingtalk\.com/)
  const state = new URL(auth.url).searchParams.get('state')
  assert.ok(state)

  // redirect: manual —— fetch 默认跟随 302，会拿最终静态页的 404
  const okRes = await fetch(
    `${app.base}/api/auth/oauth/dingtalk/callback?code=oauth-ok&state=${encodeURIComponent(String(state))}`,
    { redirect: 'manual' },
  )
  assert.equal(okRes.status, 302)
  assert.equal(okRes.headers.get('location'), `/t/${slugA}/`)
  assert.ok(
    (okRes.headers.getSetCookie?.() ?? []).some((/** @type {string} */ c) => c.startsWith('sid=')),
    '应下发会话 cookie',
  )

  const usersBefore = await q({}, `SELECT id FROM auth_user`, [])
  const ghost = await call(
    'GET',
    `/api/auth/oauth/dingtalk/callback?code=oauth-ghost&state=${encodeURIComponent(String(state))}`,
  )
  assert.equal(ghost.status, 403)
  const err = await jsonOf(ghost)
  assert.match(err.error.message, /同步通讯录/)
  const usersAfter = await q({}, `SELECT id FROM auth_user`, [])
  assert.equal(usersAfter.length, usersBefore.length, '未映射不能自动建号')
})

test('群机器人：钉钉带 timestamp+sign，body 含文本；企微纯 POST', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  fake.requests.length = 0
  await sendText('dingtalk', { webhookUrl: `${base}/robot/send`, secret: 'robot-secret' }, '构建完成')
  const ding = fake.requests.at(-1)
  assert.equal(ding.path, '/robot/send')
  assert.ok(ding.query.timestamp)
  assert.ok(ding.query.sign)
  const expected = createHmac('sha256', 'robot-secret')
    .update(`${ding.query.timestamp}\nrobot-secret`)
    .digest('base64')
  assert.equal(ding.query.sign, expected)
  assert.equal(ding.body.msgtype, 'text')
  assert.match(ding.body.text.content, /构建完成/)

  await sendText('wecom', { webhookUrl: `${base}/cgi-bin/webhook/send?key=abc` }, '企微消息')
  const wecom = fake.requests.at(-1)
  assert.equal(wecom.path, '/cgi-bin/webhook/send')
  assert.equal(wecom.query.key, 'abc')
  assert.equal(wecom.query.sign, undefined)
  assert.equal(wecom.body.text.content, '企微消息')
})

test('跨租户 404；未知字段 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  assert.equal((await call('PUT', `/t/${slugB}/api/integrations/${connA}`, { corpId: 'x' }, cookieB)).status, 404)
  assert.equal((await call('GET', `/t/${slugB}/api/integrations/${connA}/logs`, undefined, cookieB)).status, 404)
  assert.equal((await call('POST', `/t/${slugB}/api/integrations/${connA}/sync`, undefined, cookieB)).status, 404)

  const bad = await call('PUT', `/t/${slugA}/api/integrations/${connA}`, { foo: 'bar' })
  assert.equal(bad.status, 400)
  assert.match((await jsonOf(bad)).error.message, /未知字段/)
})
