import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { close, connect, exec } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { register } from '../api/routes-w.mjs'

/**
 * 工作台聚合接口（M1 UI · 只读）：
 *   - 未登录 401（不泄漏任何聚合数字）
 *   - 跨租户不串数据：B 公司看到的是自己的空盘，不是 A 的
 *   - 返回结构固定：counts / contractAmount / recentStages / todos
 */
const password = 'test-pass-123'
const slugA = `wa${Date.now().toString(36)}`
const slugB = `wb${Date.now().toString(36)}`
const emailA = `wa-${randomUUID().slice(0, 8)}@example.com`
const emailB = `wb-${randomUUID().slice(0, 8)}@example.com`

/** @type {any} */
let app
let cookieA = ''
let cookieB = ''
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
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲集成', email: emailA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙集成', email: emailB, password })
  app = await makeApp(register)
  cookieA = await app.login(emailA, password)
  cookieB = await app.login(emailB, password)
})

test.after(async () => {
  if (app) await app.close()
})

const A = (/** @type {string} */ p) => `/t/${slugA}${p}`
const B = (/** @type {string} */ p) => `/t/${slugB}${p}`

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {string} [cookie]
 */
async function call(method, path, body, cookie = cookieA) {
  const res = await app.call(method, path, body, cookie)
  return { status: res.status, body: await jsonOf(res) }
}

/** 建单（期望 201） @param {string} path @param {unknown} body */
async function create(path, body) {
  const r = await call('POST', path, body)
  assert.equal(r.status, 201, `${path} 应 201：${JSON.stringify(r.body)}`)
  return r.body
}

/** 动作（期望 200） @param {string} path @param {unknown} body */
async function act(path, body) {
  const r = await call('POST', path, body)
  assert.equal(r.status, 200, `${path} 应 200：${JSON.stringify(r.body)}`)
  return r.body
}

/** 从商机立项出项目，再按 path 逐级推进 @param {string} name @param {string[]} path */
async function makeProject(name, path) {
  const stamp = randomUUID().slice(0, 6)
  const party = await create(A('/api/parties'), { code: `C${stamp}`, name: `${name}客户`, partyType: 'customer' })
  const opp = await create(A('/api/opportunities'), {
    code: `O${stamp}`,
    name,
    partyId: party.id,
    estAmount: 1,
  })
  await act(A(`/api/opportunities/${opp.id}/advance`), { to: 'following' })
  const won = await act(A(`/api/opportunities/${opp.id}/advance`), { to: 'won' })
  const projectId = won.project.id
  for (const to of path) await act(A(`/api/projects/${projectId}/advance`), { to })
  return projectId
}

test('未登录 → 401', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const r = await call('GET', A('/api/workbench'), undefined, '')
  assert.equal(r.status, 401)
})

test('返回结构完整，数字来自本公司数据', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  // 一号项目走到签约（合同额 20000 写回项目头）
  const pid = await makeProject('政务云集成', ['approved', 'designing', 'quoting'])
  const doc = await create(A('/api/design-docs'), {
    projectId: pid,
    title: '方案 v1',
    bomLines: [
      { lineNo: 1, itemName: '核心交换机', spec: '24口', uom: '台', qty: 2, unitCost: '5000.00' },
      { lineNo: 2, itemName: '接入交换机', spec: '48口', uom: '台', qty: 10, unitCost: '1000.00' },
    ],
  })
  await act(A(`/api/design-docs/${doc.id}/advance`), { to: 'confirmed' })
  const quo = await create(A('/api/quotations'), { designDocId: doc.id })
  await act(A(`/api/quotations/${quo.id}/advance`), { to: 'sent' })
  await act(A(`/api/quotations/${quo.id}/advance`), { to: 'accepted' })
  const con = await create(A('/api/contracts'), {
    quotationId: quo.id,
    code: `HT${randomUUID().slice(0, 6)}`,
    name: '政务云集成合同',
  })
  await act(A(`/api/contracts/${con.id}/advance`), { to: 'signed' })

  // 二号项目停在报价中 → 进待办
  const pid2 = await makeProject('园区改造', ['approved', 'designing', 'quoting'])

  const r = await call('GET', A('/api/workbench'))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const body = r.body

  assert.deepEqual(Object.keys(body).sort(), ['contractAmount', 'counts', 'recentStages', 'todos'])
  assert.deepEqual(Object.keys(body.counts).sort(), ['contract', 'opportunity', 'project', 'quotation'])
  assert.equal(body.counts.project, 2)
  assert.equal(body.counts.opportunity, 2)
  assert.equal(body.counts.quotation, 1)
  assert.equal(body.counts.contract, 1)
  assert.equal(body.contractAmount, '20000.00')

  // 最近动态：倒序，最新一条是签约
  assert.ok(body.recentStages.length >= 1, '签约后必须留下状态流水')
  const first = body.recentStages[0]
  assert.deepEqual(Object.keys(first).sort(), [
    'at',
    'fromStatus',
    'projectCode',
    'projectId',
    'projectName',
    'toStatus',
  ])
  assert.equal(first.projectId, pid2, '最新一条流水属于后立项的那个项目')
  assert.equal(first.toStatus, 'quoting')
  const signedLog = body.recentStages.find((/** @type {any} */ s) => s.projectId === pid)
  assert.ok(signedLog, '签约必须留下流水')
  assert.equal(signedLog.fromStatus, 'quoting')
  assert.equal(signedLog.toStatus, 'signed')
  assert.ok(first.projectCode.length > 0 && first.projectName.length > 0, '流水要带得出项目编码与名称')
  const ats = body.recentStages.map((/** @type {any} */ s) => new Date(s.at).getTime())
  assert.deepEqual(ats, [...ats].sort((/** @type {number} */ x, /** @type {number} */ y) => y - x), '流水按时间倒序')

  // 待办：只有报价中的那条
  assert.equal(body.todos.length, 1)
  assert.equal(body.todos[0].projectId, pid2)
  assert.equal(body.todos[0].status, 'quoting')
  assert.deepEqual(Object.keys(body.todos[0]).sort(), ['code', 'name', 'projectId', 'status', 'updatedAt'])
})

test('跨租户不串数据：B 公司看到空盘', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const r = await call('GET', B('/api/workbench'), undefined, cookieB)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.deepEqual(r.body.counts, { project: 0, opportunity: 0, quotation: 0, contract: 0 })
  assert.equal(r.body.contractAmount, '0.00')
  assert.deepEqual(r.body.recentStages, [])
  assert.deepEqual(r.body.todos, [])

  // 反向确认 A 不因 B 的请求被清空
  const a = await call('GET', A('/api/workbench'))
  assert.equal(a.body.counts.project, 2)
})
