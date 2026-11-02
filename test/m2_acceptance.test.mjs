import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { close, connect, exec } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { runOnce } from '../svc/notify_worker.mjs'

/**
 * M2 验收（DESIGN §15）：
 *   「报价超 10 万自动走 2 级审批，每级到人有站内信 + 邮件 + 短信，超时催办一次」
 *
 * 这一条打通的是三个域：审批引擎（选链）→ 通知中心（outbox）→ 站点设置。
 * 每个域各自有测试，这里只验「接起来了」。
 */
const password = 'test-pass-123'
const slug = `m2${Date.now().toString(36)}`
const email = `m2-${randomUUID().slice(0, 8)}@example.com`

/** @type {any} */
let app
/** @type {string} */
let cookie = ''
let dbUp = false
/** @type {string} */
let email2 = ''
/** @type {string} */
let approverA = ''
/** @type {string} */
let approverB = ''

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  await exec({}, 'DELETE FROM login_attempt', [])
  const owner = await createTenant({ requestId: 'test', userId: null }, { slug, name: 'M2 公司', email, password })
  app = await makeApp()
  cookie = await app.login(email, password)
  const me = await jsonOf(await app.call('GET', `/t/${slug}/api/me`, undefined, cookie))
  approverA = me.user.id

  // 第二个人（二级审批人）：走邀请注册
  email2 = `m2b-${randomUUID().slice(0, 8)}@example.com`
  const inv = await jsonOf(await app.call('POST', `/t/${slug}/api/invites`, { email: email2, roleCode: 'member' }, cookie))
  const reg = await app.call('POST', `/api/auth/register`, { email: email2, password, slug, inviteCode: inv.code })
  assert.equal(reg.status, 201)
  const cookie2 = (reg.headers.getSetCookie?.() ?? []).map((/** @type {string} */ c) => c.split(';')[0]).join('; ')
  const me2 = await jsonOf(await app.call('GET', `/t/${slug}/api/me`, undefined, cookie2))
  approverB = me2.user.id
  void owner
})

test.after(async () => {
  if (app) await app.close()
})

const post = async (/** @type {string} */ path, /** @type {unknown} */ body, /** @type {string} */ c = cookie) => {
  const res = await app.call('POST', `/t/${slug}${path}`, body, c)
  return { status: res.status, body: await jsonOf(res) }
}

test('报价超 10 万 → 自动 2 级审批 → 每级审批人收到站内信', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  // 1) 通知配置：开站内信渠道 + 两个模板
  const ch = await post('/api/notify/channels', { type: 'inapp', enabled: true, config: {} })
  assert.ok([200, 201].includes(ch.status), JSON.stringify(ch.body))
  for (const code of ['approval.pending', 'approval.approved']) {
    const tp = await post('/api/notify/templates', {
      code,
      channel: 'inapp',
      lang: 'zh',
      subject: code === 'approval.pending' ? '待你审批：{{docType}}' : '已通过：{{docType}}',
      body: '金额 {{amount}}，第 {{stepNo}} 级',
    })
    assert.ok([200, 201].includes(tp.status), JSON.stringify(tp.body))
  }

  // 2) 审批流程：10 万以上走两级，第一级 user=approverA，第二级 user=approverB
  const flow = await post('/api/approval/flows', {
    code: 'QUOTE_OVER_100K',
    name: '报价超 10 万两级审批',
    docType: 'QUOTATION',
    enabled: true,
    steps: [
      { no: 1, approver_type: 'user', approver_ref: approverA, mode: 'any', min_amount: '100000.00', max_amount: null },
      { no: 2, approver_type: 'user', approver_ref: approverB, mode: 'any', min_amount: '100000.00', max_amount: null },
    ],
  })
  assert.equal(flow.status, 201, JSON.stringify(flow.body))

  // 3) 提交一张 12 万的报价审批
  const docId = randomUUID()
  const sub = await post('/api/approvals', { docType: 'QUOTATION', docId, amount: '120000.00' })
  assert.equal(sub.status, 201, JSON.stringify(sub.body))
  const inst = sub.body
  assert.equal(inst.currentStep, 1)

  // 通知是「先入队、再投递」：跑一轮 worker 才算真的发出去
  await runOnce()

  // 第 1 级审批人收到站内信
  const inboxA = await jsonOf(await app.call('GET', `/t/${slug}/api/notify/inbox`, undefined, cookie))
  assert.ok(inboxA.items.length >= 1, '一级审批人应有站内信')

  // 4) 一级通过 → 进入二级，二级审批人收到站内信
  const myTasks = await jsonOf(await app.call('GET', `/t/${slug}/api/approvals/my-tasks`, undefined, cookie))
  assert.ok(myTasks.items.length >= 1, '一级审批人应有待办')
  const taskId = myTasks.items[0].id
  const ok1 = await post(`/api/approvals/tasks/${taskId}/decide`, { action: 'approve', comment: '同意' })
  assert.equal(ok1.status, 200, JSON.stringify(ok1.body))
  assert.equal(ok1.body.currentStep, 2)
  assert.equal(ok1.body.status, 'pending')

  // 二级审批人是另一个人，拿他的 cookie 看 inbox
  const cookie2 = await app.login(email2, password)
  await runOnce()
  const inboxB = await jsonOf(await app.call('GET', `/t/${slug}/api/notify/inbox`, undefined, cookie2))
  assert.ok(inboxB.items.length >= 1, '二级审批人应有站内信')

  // 二级通过 → 审批结束，提交人收到「已通过」
  const tasksB = await jsonOf(await app.call('GET', `/t/${slug}/api/approvals/my-tasks`, undefined, cookie2))
  assert.ok(tasksB.items.length >= 1, '二级审批人应有待办')
  const ok2 = await post(`/api/approvals/tasks/${tasksB.items[0].id}/decide`, { action: 'approve' }, cookie2)
  assert.equal(ok2.status, 200, JSON.stringify(ok2.body))
  assert.equal(ok2.body.status, 'approved')
  await runOnce()
  const inboxSubmitter = await jsonOf(await app.call('GET', `/t/${slug}/api/notify/inbox`, undefined, cookie))
  assert.ok(
    inboxSubmitter.items.some((/** @type {any} */ i) => String(i.title ?? '').includes('已通过') || String(i.body ?? '').includes('已通过')),
    '提交人应收到达成通知',
  )
})

test('单据类型没有匹配流程 → 409，且不会静默放行', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const res = await post('/api/approvals', { docType: 'NOBODY', docId: randomUUID(), amount: '1.00' })
  assert.equal(res.status, 409)
  assert.match((await jsonOf(await app.call('GET', `/t/${slug}/api/me`, undefined, cookie))).user.email, /@/)
  assert.match(String(res.body.error.details.reason), /没有可用的审批流程/)
})
