import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { connect, exec } from '../db/index.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { jsonOf, makeApp } from './helpers.mjs'

/**
 * M5 售后域验收用例（DESIGN §15）：
 *   工单状态机不可跳级、挂起真正暂停 SLA、超时查询、满意度只对已关闭、
 *   跨租户 404、未知字段 400、编码/版本冲突 409、游标分页。
 */
const password = 'test-pass-123'
const stamp = Date.now().toString(36).toUpperCase()
const slugA = `sa${Date.now().toString(36)}`
const slugB = `sb${Date.now().toString(36)}`
const emailA = `sa-${randomUUID().slice(0, 8)}@example.com`
const emailB = `sb-${randomUUID().slice(0, 8)}@example.com`

/** @type {any} */
let app
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''
let dbUp = false
let seq = 0
/** @param {string} prefix */
const code = (prefix) => `${prefix}-${stamp}-${++seq}`

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  await exec({}, 'DELETE FROM login_attempt', [])
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲售后', email: emailA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙售后', email: emailB, password })
  app = await makeApp()
  cookieA = await app.login(emailA, password)
  cookieB = await app.login(emailB, password)
})

test.after(async () => {
  if (app) await app.close()
})

const A = (/** @type {string} */ p) => `/t/${slugA}${p}`
const B = (/** @type {string} */ p) => `/t/${slugB}${p}`

/**
 * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [cookie]
 */
async function call(method, path, body, cookie = cookieA) {
  const res = await app.call(method, path, body, cookie)
  return { status: res.status, body: await jsonOf(res) }
}

/** @param {string} [prefix] */
async function makeParty(prefix = 'C') {
  const r = await call('POST', A('/api/parties'), {
    code: code(prefix),
    name: `客户 ${prefix}`,
    partyType: 'customer',
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

/**
 * @param {any} party
 * @param {{ responseMinutes?: number, resolveMinutes?: number, code?: string }} [opts]
 */
async function makeContract(party, opts = {}) {
  const r = await call('POST', A('/api/service-contracts'), {
    code: opts.code ?? code('SC'),
    partyId: party.id,
    name: '年度运维服务',
    startAt: new Date(Date.now() - 86400000).toISOString(),
    endAt: new Date(Date.now() + 86400000 * 365).toISOString(),
    slaLevel: 'P1',
    responseMinutes: opts.responseMinutes ?? 60,
    resolveMinutes: opts.resolveMinutes ?? 240,
    amount: '120000.50',
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

/** @param {any} contract @param {Record<string, unknown>} [extra] */
async function makeTicket(contract, extra = {}) {
  const r = await call('POST', A('/api/tickets'), {
    code: code('T'),
    contractId: contract.id,
    title: '核心交换机离线',
    content: '客户反馈核心交换机无法管理',
    sn: 'SN-0001',
    priority: 'high',
    ...extra,
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

/** @param {string} id @param {string} to */
const advance = (id, to) => call('POST', A(`/api/tickets/${id}/advance`), { to })

test('完整链路：建单 → 派工 → 处理中 → 待验证 → 关闭，ticket_event 逐条累积', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await makeParty('FLOW')
  const contract = await makeContract(party)
  const ticket = await makeTicket(contract)

  assert.equal(ticket.status, '待受理')
  assert.ok(ticket.slaDueAt, '建单时按 response_minutes 算出 SLA 到期')
  assert.deepEqual(ticket.allowed, ['已派工'])

  const engineerId = randomUUID()
  const dispatched = await call('POST', A(`/api/tickets/${ticket.id}/dispatch`), {
    engineerId,
    note: '派给张工',
  })
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.body))
  assert.equal(dispatched.body.status, '已派工')
  assert.equal(dispatched.body.assigneeId, engineerId)
  assert.ok(dispatched.body.respondedAt, '派工即首次响应')
  assert.equal(dispatched.body.dispatches.length, 1)

  for (const to of ['处理中', '待验证', '已关闭']) {
    const r = await advance(ticket.id, to)
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.status, to)
  }

  const detail = (await call('GET', A(`/api/tickets/${ticket.id}`))).body
  assert.equal(detail.status, '已关闭')
  assert.ok(detail.resolvedAt)
  assert.deepEqual(detail.allowed, [])
  assert.deepEqual(
    detail.events.map((/** @type {any} */ e) => e.action),
    ['created', 'dispatch', 'advance', 'advance', 'advance'],
  )
  assert.equal(detail.events.length, 5)
  assert.equal(detail.dispatches.length, 1)
})

test('非法跳转 409，details.allowed 带出合法目标', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await makeParty('BAD')
  const contract = await makeContract(party)
  const ticket = await makeTicket(contract)

  const r = await advance(ticket.id, '已关闭')
  assert.equal(r.status, 409)
  assert.equal(r.body.error.code, 'conflict')
  assert.deepEqual(r.body.error.details.allowed, ['已派工'])
  assert.match(r.body.error.message, /不允许/)
})

test('挂起 → 恢复：sla_due_at 往后推，暂停时长写进事件', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await makeParty('PAUSE')
  const contract = await makeContract(party, { responseMinutes: 30, resolveMinutes: 240 })
  const ticket = await makeTicket(contract)
  assert.equal((await call('POST', A(`/api/tickets/${ticket.id}/dispatch`), { engineerId: randomUUID() })).status, 200)
  assert.equal((await advance(ticket.id, '处理中')).status, 200)

  const before = (await call('GET', A(`/api/tickets/${ticket.id}`))).body
  assert.ok(before.slaDueAt)

  const paused = await call('POST', A(`/api/tickets/${ticket.id}/pause`), { comment: '等客户配件' })
  assert.equal(paused.status, 200, JSON.stringify(paused.body))
  assert.equal(paused.body.status, '挂起')
  assert.equal(paused.body.canResume, true)
  assert.equal(paused.body.events.at(-1).action, 'paused')

  await new Promise((r) => setTimeout(r, 40))

  const resumed = await call('POST', A(`/api/tickets/${ticket.id}/resume`), { comment: '配件到货' })
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body))
  assert.equal(resumed.body.status, '处理中')
  assert.ok(new Date(resumed.body.slaDueAt) > new Date(before.slaDueAt), '暂停时长必须补回 SLA')
  const last = resumed.body.events.at(-1)
  assert.equal(last.action, 'resumed')
  assert.match(String(last.comment), /paused_ms=\d+/)
})

test('SLA 超时查询：小 response_minutes 能查出，已关闭不出现', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await makeParty('SLA')
  const contract = await makeContract(party, { responseMinutes: 1, resolveMinutes: 1 })
  const overdueTicket = await makeTicket(contract, {
    code: code('SLA-T'),
    sn: 'SN-SLA-1',
    reportedAt: new Date(Date.now() - 3600_000).toISOString(),
  })

  const overdue = await call('GET', A('/api/sla/overdue'))
  assert.equal(overdue.status, 200, JSON.stringify(overdue.body))
  const hit = overdue.body.items.find((/** @type {any} */ x) => x.id === overdueTicket.id)
  assert.ok(hit, '超过 1 分钟未响应的工单必须在超时列表里')
  assert.ok(hit.overdueMinutes >= 59)
  assert.equal(hit.remainingMinutes, 0)

  // 同一合同下再走一条完整链路到关闭，关闭后不能出现在 SLA 超时列表
  const closing = await makeTicket(contract, { reportedAt: new Date(Date.now() - 3600_000).toISOString() })
  await call('POST', A(`/api/tickets/${closing.id}/dispatch`), { engineerId: randomUUID() })
  for (const to of ['处理中', '待验证', '已关闭']) assert.equal((await advance(closing.id, to)).status, 200)

  const again = await call('GET', A('/api/sla/overdue'))
  const ids = again.body.items.map((/** @type {any} */ x) => x.id)
  assert.ok(ids.includes(overdueTicket.id))
  assert.ok(!ids.includes(closing.id), '已关闭工单不算 SLA 超时')
})

test('满意度只能对已关闭工单登记，否则 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await makeParty('SAT')
  const contract = await makeContract(party)
  const ticket = await makeTicket(contract)

  const early = await call('POST', A(`/api/tickets/${ticket.id}/satisfaction`), { score: 5 })
  assert.equal(early.status, 409)

  await call('POST', A(`/api/tickets/${ticket.id}/dispatch`), { engineerId: randomUUID() })
  for (const to of ['处理中', '待验证', '已关闭']) assert.equal((await advance(ticket.id, to)).status, 200)

  const ok = await call('POST', A(`/api/tickets/${ticket.id}/satisfaction`), { score: 5, comment: '响应很快' })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.satisfaction.score, 5)
  assert.match(String(ok.body.satisfaction.comment), /响应很快/)

  const bad = await call('POST', A(`/api/tickets/${ticket.id}/satisfaction`), { score: 6 })
  assert.equal(bad.status, 400)
})

test('跨租户 404、未知字段 400、游标分页不重不漏', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await makeParty('TEN')
  const contract = await makeContract(party)
  const ticket = await makeTicket(contract)

  assert.equal((await call('GET', B(`/api/tickets/${ticket.id}`), undefined, cookieB)).status, 404)
  assert.equal((await call('GET', B(`/api/service-contracts/${contract.id}`), undefined, cookieB)).status, 404)
  assert.equal(
    (await call('POST', B(`/api/tickets/${ticket.id}/advance`), { to: '已派工' }, cookieB)).status,
    404,
  )

  const unknownContract = await call('POST', A('/api/service-contracts'), {
    code: code('UNK'),
    partyId: party.id,
    name: '带未知字段的合同',
    nope: 1,
  })
  assert.equal(unknownContract.status, 400)
  const unknownTicket = await call('POST', A('/api/tickets'), { contractId: contract.id, title: 'x', nope: 1 })
  assert.equal(unknownTicket.status, 400)

  // 用唯一 q 前缀圈出 5 条合同，limit=2 游标翻完
  const prefix = `PG-${stamp}`
  for (let i = 0; i < 5; i++) {
    await makeContract(party, { code: `${prefix}-${i}` })
  }
  /** @type {string[]} */
  const seen = []
  let cursor = ''
  for (let pageNo = 0; pageNo < 10; pageNo++) {
    const path = A(`/api/service-contracts?q=${encodeURIComponent(prefix)}&limit=2${cursor ? `&cursor=${cursor}` : ''}`)
    const page = await call('GET', path)
    assert.equal(page.status, 200, JSON.stringify(page.body))
    seen.push(...page.body.items.map((/** @type {any} */ x) => x.code))
    if (!page.body.nextCursor) break
    cursor = page.body.nextCursor
  }
  assert.equal(seen.length, 5)
  assert.equal(new Set(seen).size, 5)
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3, 4].map((i) => `${prefix}-${i}`).sort())
})

test('编码重复 409、旧 version 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await makeParty('DUP')
  const contract = await makeContract(party)

  const dupContract = await call('POST', A('/api/service-contracts'), {
    code: contract.code,
    partyId: party.id,
    name: '重复编号合同',
  })
  assert.equal(dupContract.status, 409)

  const ticket = await makeTicket(contract)
  const dupTicket = await call('POST', A('/api/tickets'), { code: ticket.code, contractId: contract.id, title: '重复工单' })
  assert.equal(dupTicket.status, 409)

  const updated = await call('PATCH', A(`/api/service-contracts/${contract.id}`), {
    name: '改名后的合同',
    version: contract.version,
  })
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(updated.body.version, contract.version + 1)

  const stale = await call('PATCH', A(`/api/service-contracts/${contract.id}`), {
    name: '用旧版本覆盖',
    version: contract.version,
  })
  assert.equal(stale.status, 409)
})
