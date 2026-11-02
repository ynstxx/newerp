import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { connect, exec, q } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'
import * as notify from '../svc/notify.mjs'
import { createWorker } from '../svc/notify_worker.mjs'
import { decrypt } from '../svc/notify_crypto.mjs'

/**
 * 通知中心。外部服务一律用本进程 node:http 假服务器（契约 §4，不真连外网、不引 mock 库）。
 * outbox/inbox 的断言直接走 SQL，避免用被测的 svc 去验证被测的 svc。
 * 注意：断言按 `dedupe_key` 或模板 code 定位行，不用 JSON 路径查询（两库不通用）。
 */

const password = 'test-pass-123'
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const ownerA = `na-${stamp}@example.com`
const ownerB = `nb-${stamp}@example.com`
const slugA = `na${stamp}`
const slugB = `nb${stamp}`

/** @type {any} */
let app
let dbUp = false
let cookieA = ''
let cookieB = ''
let tenantA = ''
let userA = ''
/** @type {any} */
let fake

/** emit 用的服务端上下文（真实环境里 tenantId 只来自中间件） */
const ctxA = () => ({ tenantId: tenantA, userId: userA, requestId: `t-${stamp}` })

/** @param {string} sql @param {unknown[]} [args] */
const sys = (sql, args = []) => q({}, sql, args)

/**
 * @param {{ channel: string, templateCode: string, docId: string, toAddr: string, step?: string }} p
 */
const keyOf = (p) => notify.dedupeKey({ tenantId: tenantA, step: '', ...p })

/** @param {string} key */
const rowOfKey = async (key) =>
  (
    await sys(
      `SELECT channel, status, attempts, next_retry_at, error FROM notify_outbox WHERE tenant_id = $1 AND dedupe_key = $2`,
      [tenantA, key],
    )
  )[0]

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }

  // 假外部服务：/ok 成功、/fail 500、/dingtalk 与 /wecom 记录请求
  /** @type {any[]} */
  const hits = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    /** @type {any} */
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = raw
    }
    hits.push({ url: req.url ?? '', method: req.method, headers: req.headers, body })
    if ((req.url ?? '').startsWith('/fail')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"message":"boom"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"id":"msg_1","errcode":0,"errmsg":"ok"}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address())
  fake = { hits, base: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r(null))) }

  await exec({}, 'DELETE FROM login_attempt', [])
  const ctx = { requestId: 'test', userId: null }
  await createTenant(ctx, { slug: slugA, name: '甲通知公司', email: ownerA, password })
  await createTenant(ctx, { slug: slugB, name: '乙通知公司', email: ownerB, password })

  app = await makeApp()
  cookieA = await app.login(ownerA, password)
  cookieB = await app.login(ownerB, password)
  const meA = await jsonOf(await app.call('GET', `/t/${slugA}/api/me`, undefined, cookieA))
  tenantA = meA.tenant.id
  userA = meA.user.id
})

test.after(async () => {
  await fake?.close()
  await app?.close()
})

/** 建模板（走 API，顺便覆盖端点） */
/** @param {string} channel @param {string} code @param {string} subject @param {string} body */
const addTemplate = (channel, code, subject, body) =>
  app.call('POST', `/t/${slugA}/api/notify/templates`, { code, channel, lang: 'zh', subject, body }, cookieA)

/** 改 email 渠道的 path（假服务器的 /ok 或 /fail） */
/** @param {string} path */
async function setEmailPath(path) {
  const list = await jsonOf(await app.call('GET', `/t/${slugA}/api/notify/channels`, undefined, cookieA))
  const email = list.items.find((/** @type {any} */ c) => c.type === 'email')
  const res = await app.call('PUT', `/t/${slugA}/api/notify/channels/${email.id}`, { config: { path } }, cookieA)
  assert.equal(res.status, 200)
  return email.id
}

// —— 1. emit 落 outbox，worker 跑一轮 → sent ——
test('emit 入队 → worker 一轮发出 email + inapp', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const chRes = await app.call(
    'POST',
    `/t/${slugA}/api/notify/channels`,
    { type: 'email', config: { base_url: fake.base, path: '/ok', api_key: 'k-1', from: 'noreply@example.com' } },
    cookieA,
  )
  assert.equal(chRes.status, 201)
  assert.equal((await jsonOf(chRes)).config.configured, true)

  assert.equal((await addTemplate('email', 'approval.pending', '待审批 {{docNo}}', '单据 {{docNo}} 金额 {{amount}}')).status, 201)
  assert.equal((await addTemplate('inapp', 'approval.pending', '待办 {{docNo}}', '单据 {{docNo}} 等你处理')).status, 201)

  const docId = randomUUID()
  const out = await notify.emit(ctxA(), 'approval.pending', {
    docType: 'purchase_order',
    docId,
    recipients: [{ userId: userA }],
    vars: { docNo: 'PO-001', amount: '1,234.56' },
  })
  assert.equal(out.queued, 2, JSON.stringify(out))

  const mailRow = await rowOfKey(keyOf({ channel: 'email', templateCode: 'approval.pending', docId, toAddr: ownerA }))
  const inboxRow = await rowOfKey(keyOf({ channel: 'inapp', templateCode: 'approval.pending', docId, toAddr: userA }))
  assert.equal(mailRow.status, 'pending')
  assert.equal(inboxRow.status, 'pending')

  const worker = createWorker({ intervalMs: 0 })
  const stats = await worker.runOnce()
  assert.equal(stats.claimed, 2)
  assert.equal(stats.sent, 2)

  assert.equal((await rowOfKey(keyOf({ channel: 'email', templateCode: 'approval.pending', docId, toAddr: ownerA }))).status, 'sent')
  assert.equal((await rowOfKey(keyOf({ channel: 'inapp', templateCode: 'approval.pending', docId, toAddr: userA }))).status, 'sent')

  // 真的打到假服务器，且模板渲染过
  const mail = fake.hits.filter((/** @type {any} */ h) => h.url === '/ok').at(-1)
  assert.ok(mail, '没有发出邮件请求')
  assert.deepEqual(mail.body.to, [ownerA])
  assert.equal(mail.body.subject, '待审批 PO-001')
  assert.match(mail.body.text, /1,234\.56/)
  assert.equal(mail.headers.authorization, 'Bearer k-1')
})

// —— 2. 幂等 ——
test('同一参数 emit 两次只入队一次（撞唯一键不算错）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const docId = randomUUID()
  const opts = { docType: 'purchase_order', docId, recipients: [{ userId: userA }], vars: { docNo: 'PO-002' } }

  const first = await notify.emit(ctxA(), 'approval.pending', opts)
  assert.equal(first.queued, 2)
  assert.equal(first.deduped, 0)

  const second = await notify.emit(ctxA(), 'approval.pending', opts)
  assert.equal(second.queued, 0)
  assert.equal(second.deduped, 2)

  const total = await sys(
    `SELECT COUNT(*) AS n FROM notify_outbox WHERE tenant_id = $1 AND dedupe_key IN ($2, $3)`,
    [tenantA, keyOf({ channel: 'email', templateCode: 'approval.pending', docId, toAddr: ownerA }), keyOf({ channel: 'inapp', templateCode: 'approval.pending', docId, toAddr: userA })],
  )
  assert.equal(Number(total[0].n), 2, '重复 emit 多入队了')

  // 不同 step = 不同一轮通知，允许再次入队
  const third = await notify.emit(ctxA(), 'approval.pending', { ...opts, step: 'remind-1' })
  assert.equal(third.queued, 2)

  // 排空，避免影响后面的用例
  await createWorker({ intervalMs: 0 }).runOnce()
})

// —— 3. 模板缺失 → failed + error ——
test('模板缺失落 failed 并写 error，不静默吞掉', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const docId = randomUUID()
  const out = await notify.emit(ctxA(), 'stock.low', {
    docType: 'item',
    docId,
    recipients: [{ userId: userA }],
    vars: { item: '螺栓' },
  })
  assert.ok(out.failed >= 1, JSON.stringify(out))

  const rows = await sys(
    `SELECT channel, status, error FROM notify_outbox WHERE tenant_id = $1 AND template_code = 'stock.low'`,
    [tenantA],
  )
  assert.ok(rows.length >= 1)
  for (const r of rows) {
    assert.equal(r.status, 'failed')
    assert.match(String(r.error), /模板缺失/)
  }
  // 已启用且配过的 email 也在候选渠道里，同样落 failed
  assert.ok(rows.some((/** @type {any} */ r) => r.channel === 'email'))
})

// —— 4. 失败重试与退避 ——
test('发送失败：attempts+1 且 next_retry_at 后推，5 次后 failed + 通知管理员', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  await setEmailPath('/fail')
  assert.equal((await addTemplate('email', 'ar.overdue', '逾期 {{docNo}}', '请处理')).status, 201)
  assert.equal((await addTemplate('inapp', 'ar.overdue', '逾期 {{docNo}}', '请处理')).status, 201)

  const docId = randomUUID()
  const key = keyOf({ channel: 'email', templateCode: 'ar.overdue', docId, toAddr: ownerA })
  await notify.emit(ctxA(), 'ar.overdue', { docType: 'invoice', docId, recipients: [{ userId: userA }], vars: { docNo: 'AR-1' } })

  // 用可推进的时钟跑 5 轮：每轮把 now 推到 next_retry_at 之后
  let nowMs = Date.now()
  const worker = createWorker({ intervalMs: 0, clock: () => new Date(nowMs) })

  const hitsBefore = fake.hits.length
  await worker.runOnce()
  const r1 = await rowOfKey(key)
  assert.equal(r1.attempts, 1)
  assert.equal(r1.status, 'pending')
  assert.ok(new Date(r1.next_retry_at).getTime() > Date.now(), 'next_retry_at 应后推到未来')
  // 15s 超时 + 最多 2 次重试 → 一次投递打 3 个请求
  assert.equal(fake.hits.length - hitsBefore, 3)

  for (let i = 2; i <= 5; i++) {
    nowMs += 6 * 60 * 60 * 1000
    await worker.runOnce()
    const rr = await rowOfKey(key)
    assert.equal(rr.attempts, i)
    assert.equal(rr.status, i >= 5 ? 'failed' : 'pending')
    assert.ok(String(rr.error).length > 0)
  }

  const admins = await sys(
    `SELECT title, body FROM notify_inbox WHERE tenant_id = $1 AND user_id = $2 AND title = '通知发送失败'`,
    [tenantA, userA],
  )
  assert.equal(admins.length, 1)
  assert.match(String(admins[0].body), /ar\.overdue|连续失败/)
})

// —— 5. 站内信 ——
test('站内信进 inbox、单条已读、全部已读', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  await setEmailPath('/ok')
  const docId = randomUUID()
  await notify.emit(ctxA(), 'approval.pending', {
    docType: 'purchase_order',
    docId,
    recipients: [{ userId: userA }],
    vars: { docNo: 'PO-读' },
  })
  await createWorker({ intervalMs: 0 }).runOnce()

  const list = await jsonOf(await app.call('GET', `/t/${slugA}/api/notify/inbox`, undefined, cookieA))
  assert.ok(list.items.length >= 1)
  assert.ok(list.unread >= 1)
  const item = list.items.find((/** @type {any} */ i) => /PO-读/.test(i.title))
  assert.ok(item, '站内信没进 inbox')
  assert.equal(item.readAt, null)

  const read = await app.call('POST', `/t/${slugA}/api/notify/inbox/${item.id}/read`, undefined, cookieA)
  assert.equal(read.status, 200)
  assert.ok((await jsonOf(read)).readAt)

  const list2 = await jsonOf(await app.call('GET', `/t/${slugA}/api/notify/inbox`, undefined, cookieA))
  assert.equal(list2.unread, list.unread - 1)

  const all = await app.call('POST', `/t/${slugA}/api/notify/inbox/read-all`, undefined, cookieA)
  assert.equal(all.status, 200)
  assert.equal((await jsonOf(all)).unread, 0)

  const list3 = await jsonOf(await app.call('GET', `/t/${slugA}/api/notify/inbox`, undefined, cookieA))
  assert.equal(list3.unread, 0)
  assert.ok(list3.items.every((/** @type {any} */ i) => i.readAt !== null))
})

// —— 6. 密钥永不回显 ——
test('密钥写入后 GET 不回显明文，落库是密文', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const list = await jsonOf(await app.call('GET', `/t/${slugA}/api/notify/channels`, undefined, cookieA))
  const email = list.items.find((/** @type {any} */ c) => c.type === 'email')

  const secret = 'SUPER-SECRET-KEY-2'
  const put = await app.call('PUT', `/t/${slugA}/api/notify/channels/${email.id}`, { config: { api_key: secret } }, cookieA)
  assert.equal(put.status, 200)
  const patched = await jsonOf(put)
  assert.equal(patched.config.configured, true)
  assert.equal(patched.config.api_key, undefined)

  const after = await app.call('GET', `/t/${slugA}/api/notify/channels`, undefined, cookieA)
  const text = await after.text()
  assert.ok(!text.includes(secret), 'GET 回显了密钥明文')

  const row = await sys(`SELECT config FROM notify_channel WHERE tenant_id = $1 AND type = 'email'`, [tenantA])
  const stored = JSON.stringify(row[0].config)
  assert.ok(!stored.includes(secret), '落库是明文密钥')
  assert.match(String(row[0].config.api_key), /^v1\./)
  assert.equal(decrypt(String(row[0].config.api_key)), secret)
  // 非密钥配置照旧直接可读（排障要看 base_url / path）
  assert.ok(row[0].config.base_url)
  assert.equal(row[0].config.path, '/ok')
})

// —— 7. 跨租户 404 / 未知字段 400 ——
test('跨租户一律 404，未知字段 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const bCh = await app.call('POST', `/t/${slugB}/api/notify/channels`, { type: 'wecom', config: { webhook: `${fake.base}/wecom` } }, cookieB)
  assert.equal(bCh.status, 201)
  const bChId = (await jsonOf(bCh)).id

  // 甲租户拿着乙租户的渠道 id
  const cross = await app.call('PUT', `/t/${slugA}/api/notify/channels/${bChId}`, { enabled: false }, cookieA)
  assert.equal(cross.status, 404)
  // 乙的渠道 id 当模板 id 也是 404
  const crossTpl = await app.call('PUT', `/t/${slugA}/api/notify/templates/${bChId}`, { body: 'x' }, cookieA)
  assert.equal(crossTpl.status, 404)

  const mine = await jsonOf(await app.call('GET', `/t/${slugA}/api/notify/channels`, undefined, cookieA))
  const emailId = mine.items.find((/** @type {any} */ c) => c.type === 'email').id

  const unknown = await app.call('PUT', `/t/${slugA}/api/notify/channels/${emailId}`, { nope: 1 }, cookieA)
  assert.equal(unknown.status, 400)
  assert.equal((await app.call('POST', `/t/${slugA}/api/notify/test`, { channel: 'inapp', secret: 'x' }, cookieA)).status, 400)

  // 乙租户读不到甲的站内信
  const inbox = await jsonOf(await app.call('GET', `/t/${slugA}/api/notify/inbox`, undefined, cookieA))
  const otherRead = await app.call('POST', `/t/${slugB}/api/notify/inbox/${inbox.items[0].id}/read`, undefined, cookieB)
  assert.equal(otherRead.status, 404)
  // 乙租户看不到甲的渠道配置
  const bList = await jsonOf(await app.call('GET', `/t/${slugB}/api/notify/channels`, undefined, cookieB))
  assert.deepEqual(
    bList.items.map((/** @type {any} */ c) => c.type),
    ['wecom'],
  )
})

// —— 8. start/stop 不泄漏 timer ——
test('worker stop() 后不再取任务，也没有悬挂 timer', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const docId = randomUUID()
  const worker = createWorker({ intervalMs: 20 })
  worker.start()
  assert.equal(worker.running, true)
  // 全量套件下这个文件会和别的测试抢同一个库，20ms 轮询 + 60ms 等待容易踩到调度抖动
  await new Promise((r) => setTimeout(r, 120))
  await worker.stop()
  assert.equal(worker.running, false)

  await notify.emit(ctxA(), 'approval.pending', {
    docType: 'purchase_order',
    docId,
    recipients: [{ userId: userA }],
    vars: { docNo: 'PO-stop' },
  })
  await new Promise((r) => setTimeout(r, 400))

  const keys = [
    keyOf({ channel: 'email', templateCode: 'approval.pending', docId, toAddr: ownerA }),
    keyOf({ channel: 'inapp', templateCode: 'approval.pending', docId, toAddr: userA }),
  ]
  for (const k of keys) assert.equal((await rowOfKey(k)).status, 'pending', 'stop() 之后仍然取任务了')

  // stop 不是单向的：新 worker 能接着把积压发完
  await createWorker({ intervalMs: 0 }).runOnce()
  for (const k of keys) assert.equal((await rowOfKey(k)).status, 'sent')
})

// —— 9. 钉钉加签 ——
test('钉钉群机器人带 timestamp + HMAC-SHA256 签名', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const secret = 'ding-secret'
  const ch = await app.call(
    'POST',
    `/t/${slugA}/api/notify/channels`,
    { type: 'dingtalk', config: { webhook: `${fake.base}/dingtalk?access_token=abc`, secret } },
    cookieA,
  )
  assert.equal(ch.status, 201)
  assert.equal((await addTemplate('dingtalk', 'ticket.assigned', '工单 {{no}}', '请查看')).status, 201)

  const docId = randomUUID()
  await notify.emit(ctxA(), 'ticket.assigned', { docType: 'ticket', docId, recipients: [{ role: 'owner' }], vars: { no: 'T-9' } })
  await createWorker({ intervalMs: 0 }).runOnce()

  const hit = fake.hits.filter((/** @type {any} */ h) => h.url.startsWith('/dingtalk')).at(-1)
  assert.ok(hit, '没有打到钉钉 webhook')
  const url = new URL(`${fake.base}${hit.url}`)
  const ts = url.searchParams.get('timestamp')
  const sign = url.searchParams.get('sign')
  assert.ok(ts && sign)
  assert.equal(sign, createHmac('sha256', secret).update(`${ts}\n${secret}`).digest('base64'))
  assert.equal(hit.body.msgtype, 'text')
  assert.match(hit.body.text.content, /T-9/)
})

// —— 11. 未读优先的游标分页 ——
test('inbox 未读优先 + 游标翻页（不用 OFFSET）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const day = 24 * 60 * 60 * 1000
  /** @param {number} n */
  const at = (n) => new Date(Date.now() + n * day)
  /** @param {string} title @param {Date} createdAt @param {boolean} read */
  const ins = (title, createdAt, read) =>
    sys(
      `INSERT INTO notify_inbox (tenant_id, id, user_id, title, body, link, read_at, created_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
      [tenantA, randomUUID(), userA, title, 'b', read ? createdAt : null, createdAt],
    )
  // 先清空这个人的站内信，让分页断言不依赖本文件前面的用例
  await sys(`DELETE FROM notify_inbox WHERE tenant_id = $1 AND user_id = $2`, [tenantA, userA])
  await ins('分页-未读新', at(3), false)
  await ins('分页-未读旧', at(2), false)
  await ins('分页-已读', at(10), true)

  const p1 = await jsonOf(await app.call('GET', `/t/${slugA}/api/notify/inbox?limit=1`, undefined, cookieA))
  assert.equal(p1.items[0].title, '分页-未读新')
  assert.ok(p1.nextCursor)

  const p2 = await jsonOf(
    await app.call('GET', `/t/${slugA}/api/notify/inbox?limit=1&cursor=${encodeURIComponent(p1.nextCursor)}`, undefined, cookieA),
  )
  assert.equal(p2.items[0].title, '分页-未读旧')

  const p3 = await jsonOf(
    await app.call('GET', `/t/${slugA}/api/notify/inbox?limit=1&cursor=${encodeURIComponent(p2.nextCursor)}`, undefined, cookieA),
  )
  assert.equal(p3.items[0].title, '分页-已读', '未读发完之后应继续翻到已读段')

  const bad = await app.call('GET', `/t/${slugA}/api/notify/inbox?cursor=not-a-cursor`, undefined, cookieA)
  assert.equal(bad.status, 400)
})

// —— 10. 测试消息 ——
test('POST /notify/test 发给本人，失败原因原样带回', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const inboxRes = await app.call('POST', `/t/${slugA}/api/notify/test`, { channel: 'inapp' }, cookieA)
  assert.equal(inboxRes.status, 200)
  assert.equal((await jsonOf(inboxRes)).ok, true)
  const rows = await sys(
    `SELECT title FROM notify_inbox WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
    [tenantA, userA],
  )
  assert.ok(rows.some((/** @type {any} */ r) => /通知测试/.test(r.title)), '测试消息没进站内信')

  await setEmailPath('/fail')
  const bad = await jsonOf(await app.call('POST', `/t/${slugA}/api/notify/test`, { channel: 'email' }, cookieA))
  assert.equal(bad.channel, 'email')
  assert.equal(bad.ok, false)
  assert.match(String(bad.error), /HTTP 500|重试/)

  await setEmailPath('/ok')
  const good = await jsonOf(await app.call('POST', `/t/${slugA}/api/notify/test`, { channel: 'email' }, cookieA))
  assert.equal(good.ok, true)
  const mail = fake.hits.filter((/** @type {any} */ h) => h.url === '/ok').at(-1)
  assert.deepEqual(mail.body.to, [ownerA])
})
