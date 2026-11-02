import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { hashPassword } from '../auth/password.mjs'
import { close, connect, exec, one } from '../db/index.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { register as registerHook, reset as resetHooks } from '../svc/approval_hooks.mjs'
import { jsonOf, makeApp } from './helpers.mjs'

/**
 * 审批引擎（DESIGN §9）：有序多级 + 金额档。
 * 每个 run 用独立 doc_type / code，避免同一库反复跑时旧流程干扰选链。
 */

const password = 'test-pass-123'
const run = randomUUID().slice(0, 8).toUpperCase()
const DT = {
  serial: `SERIAL-${run}`,
  reject: `REJECT-${run}`,
  cross: `CROSS-${run}`,
  snap: `SNAP-${run}`,
  amount: `AMOUNT-${run}`,
  all: `ALL-${run}`,
  role: `ROLE-${run}`,
  mgr: `MGR-${run}`,
  none: `NONE-${run}`,
  crud: `CRUD-${run}`,
}
const slugA = `aa${run.toLowerCase()}`
const slugB = `ab${run.toLowerCase()}`

/** @type {any} */
let app
let dbUp = false
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''
/** @type {any} */
let ownerA
/** @type {any} */
let ownerB
/** @type {any} */
let m1
/** @type {any} */
let m2
/** @type {any} */
let m3
/** @type {string} */
let tenantAId = ''
/** @type {{ action: string, docType: string, docId: string }[]} */
const hookCalls = []

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  app = await makeApp()
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲集成', email: `oa-${run}@example.com`, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙集成', email: `ob-${run}@example.com`, password })
  cookieA = await app.login(`oa-${run}@example.com`, password)
  cookieB = await app.login(`ob-${run}@example.com`, password)
  ownerA = (await jsonOf(await app.call('GET', `/t/${slugA}/api/me`, undefined, cookieA))).user
  ownerB = (await jsonOf(await app.call('GET', `/t/${slugB}/api/me`, undefined, cookieB))).user
  tenantAId = (await jsonOf(await app.call('GET', `/t/${slugA}/api/me`, undefined, cookieA))).tenant.id

  m1 = await joinMember(`m1-${run}@example.com`)
  m2 = await joinMember(`m2-${run}@example.com`)
  m3 = await joinMember(`m3-${run}@example.com`)

  resetHooks()
  /** @type {(action: string) => (ctx: any, docType: string, docId: string) => void} */
  const push = (action) => (_ctx, docType, docId) => void hookCalls.push({ action, docType, docId })
  const record = { onApproved: push('approve'), onRejected: push('reject') }
  registerHook(DT.serial, record)
  registerHook(DT.reject, record)
})

test.after(async () => {
  resetHooks()
  await app?.close()
  await close()
})

/**
 * 直接落库建一个 member 角色账号再登录（注册接口有 IP 频率限制，一次跑 3 个成员会被 429）。
 * @param {string} rawEmail
 */
async function joinMember(rawEmail) {
  const email = rawEmail.toLowerCase()
  const { hash, salt } = await hashPassword(password)
  const userId = randomUUID()
  const now = new Date()
  await exec(
    {},
    `INSERT INTO auth_user (id, email, pwd_hash, pwd_salt, display_name, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
    [userId, email, hash, salt, email.split('@')[0], now],
  )
  const role = await one(
    { tenantId: tenantAId },
    `SELECT id FROM auth_role WHERE tenant_id = $1 AND code = 'member'`,
    [tenantAId],
  )
  assert.ok(role, 'tenant 应已种入 member 角色')
  await exec(
    { tenantId: tenantAId },
    `INSERT INTO org_membership (tenant_id, user_id, role_id, status, joined_at) VALUES ($1, $2, $3, 'active', $4)`,
    [tenantAId, userId, role.id, now],
  )
  return { id: userId, cookie: await app.login(email, password), email }
}

/**
 * @param {string} method
 * @param {string} path 不含 /t/{slug}
 * @param {unknown} [body]
 * @param {string} [cookie]
 */
const call = (method, path, body, cookie = cookieA) => app.call(method, `/t/${slugA}${path}`, body, cookie)
/** @param {string} method @param {string} path @param {unknown} [body] @param {string} [cookie] */
const callB = (method, path, body, cookie = cookieB) => app.call(method, `/t/${slugB}${path}`, body, cookie)

/**
 * @param {any} res
 * @param {number} status
 */
const expectStatus = async (res, status) => {
  const body = await jsonOf(res)
  assert.equal(res.status, status, `期望 ${status}，实际 ${res.status}: ${JSON.stringify(body)}`)
  return body
}

/**
 * @param {string} docType
 * @param {any[]} steps
 * @param {string} [suffix]
 */
async function createFlow(docType, steps, suffix = '') {
  return expectStatus(
    await call('POST', '/api/approval/flows', {
      code: `F-${docType}-${suffix || 'X'}`,
      name: `流程 ${docType}`,
      docType,
      steps,
    }),
    201,
  )
}

/**
 * @param {string} docType
 * @param {string} amount
 * @param {string} [cookie]
 */
function submit(docType, amount, cookie = cookieA) {
  return call('POST', '/api/approvals', { docType, docId: randomUUID(), amount }, cookie)
}

/** @param {string} cookie @returns {Promise<any[]>} */
const myTasks = async (cookie) => (await expectStatus(await call('GET', '/api/approvals/my-tasks', undefined, cookie), 200)).items

/** @param {string} cookie @returns {Promise<any[]>} */
const myTasksB = async (cookie) => (await expectStatus(await callB('GET', '/api/approvals/my-tasks', undefined, cookie), 200)).items

test('两级串行：一级通过 → 二级出现 → 二级通过 → approved + hook', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  await createFlow(DT.serial, [
    { no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any' },
    { no: 2, approver_type: 'user', approver_ref: m2.id, mode: 'any' },
  ])

  const inst = await expectStatus(await submit(DT.serial, '1000.00'), 201)
  assert.equal(inst.status, 'pending')
  assert.equal(inst.currentStep, 1)
  assert.equal(inst.amount, '1000.00')
  assert.deepEqual(inst.allowed, ['approved', 'rejected', 'withdrawn'])

  // 一级审批人看得到；二级（还没轮到）看不到
  const t1 = await myTasks(m1.cookie)
  const task1 = t1.find((x) => x.instanceId === inst.id)
  assert.ok(task1, '一级应看到任务')
  assert.equal(task1.stepNo, 1)
  assert.equal(task1.approverUserId, m1.id)
  assert.equal((await myTasks(m2.cookie)).some((x) => x.instanceId === inst.id), false)

  const after1 = await expectStatus(
    await call('POST', `/api/approvals/tasks/${task1.id}/decide`, { action: 'approve', comment: '同意' }, m1.cookie),
    200,
  )
  assert.equal(after1.status, 'pending')
  assert.equal(after1.currentStep, 2)

  const task2 = (await myTasks(m2.cookie)).find((x) => x.instanceId === inst.id)
  assert.ok(task2, '二级任务应出现')
  assert.equal(task2.stepNo, 2)

  const done = await expectStatus(await call('POST', `/api/approvals/tasks/${task2.id}/decide`, { action: 'approve' }, m2.cookie), 200)
  assert.equal(done.status, 'approved')
  assert.ok(done.finishedAt)
  assert.deepEqual(done.allowed, [])

  const call1 = hookCalls.find((c) => c.action === 'approve' && c.docId === inst.docId)
  assert.ok(call1, 'onApproved 应被调用')
  assert.equal(call1.docType, DT.serial)
})

test('金额档：8 万走 1 级、12 万走 2 级', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  await createFlow(DT.amount, [
    { no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any', min_amount: '0.00', max_amount: '100000.00' },
    { no: 2, approver_type: 'user', approver_ref: m2.id, mode: 'any', min_amount: '100000.00', max_amount: null },
  ])

  const small = await expectStatus(await submit(DT.amount, '80000.00'), 201)
  assert.equal(small.steps.length, 1, '8 万只应有 1 级')
  assert.equal(small.currentStep, 1)

  const smallTask = (await myTasks(m1.cookie)).find((x) => x.instanceId === small.id)
  const smallDone = await expectStatus(
    await call('POST', `/api/approvals/tasks/${smallTask.id}/decide`, { action: 'approve' }, m1.cookie),
    200,
  )
  assert.equal(smallDone.status, 'approved')

  const big = await expectStatus(await submit(DT.amount, '120000.00'), 201)
  assert.equal(big.steps.length, 2, '12 万应有 2 级')
  const bigTask1 = (await myTasks(m1.cookie)).find((x) => x.instanceId === big.id)
  const bigAfter1 = await expectStatus(
    await call('POST', `/api/approvals/tasks/${bigTask1.id}/decide`, { action: 'approve' }, m1.cookie),
    200,
  )
  assert.equal(bigAfter1.status, 'pending')
  assert.equal(bigAfter1.currentStep, 2)
  const bigTask2 = (await myTasks(m2.cookie)).find((x) => x.instanceId === big.id)
  const bigDone = await expectStatus(
    await call('POST', `/api/approvals/tasks/${bigTask2.id}/decide`, { action: 'approve' }, m2.cookie),
    200,
  )
  assert.equal(bigDone.status, 'approved')
})

test("mode='all'：角色成员两人都批才过", async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  await createFlow(DT.all, [{ no: 1, approver_type: 'role', approver_ref: 'member', mode: 'all' }])
  const inst = await expectStatus(await submit(DT.all, '500.00'), 201)

  const a1 = (await myTasks(m1.cookie)).find((x) => x.instanceId === inst.id)
  const a2 = (await myTasks(m2.cookie)).find((x) => x.instanceId === inst.id)
  const a3 = (await myTasks(m3.cookie)).find((x) => x.instanceId === inst.id)
  assert.ok(a1 && a2 && a3, 'all 要生成每个成员的任务')
  assert.equal(a1.approverUserId, m1.id)

  const r1 = await expectStatus(await call('POST', `/api/approvals/tasks/${a1.id}/decide`, { action: 'approve' }, m1.cookie), 200)
  assert.equal(r1.status, 'pending', '只批一人不能过')
  const r2 = await expectStatus(await call('POST', `/api/approvals/tasks/${a2.id}/decide`, { action: 'approve' }, m2.cookie), 200)
  assert.equal(r2.status, 'pending', '仍差第三个人')
  const r3 = await expectStatus(await call('POST', `/api/approvals/tasks/${a3.id}/decide`, { action: 'approve' }, m3.cookie), 200)
  assert.equal(r3.status, 'approved')
})

test('role 型 any：myTasks 按 ctx.role.code 匹配占位任务并可认领', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  await createFlow(DT.role, [{ no: 1, approver_type: 'role', approver_ref: 'member', mode: 'any' }])
  const inst = await expectStatus(await submit(DT.role, '300.00'), 201)

  const task = (await myTasks(m2.cookie)).find((x) => x.instanceId === inst.id)
  assert.ok(task, 'member 角色应看到 role 型任务')
  assert.equal(task.approverUserId, null)
  assert.equal(task.claimable, true)
  assert.equal((await myTasks(m1.cookie)).some((x) => x.instanceId === inst.id), true)

  // owner 不是 member 角色 → 看不到
  assert.equal((await myTasks(cookieA)).some((x) => x.instanceId === inst.id), false)

  const done = await expectStatus(await call('POST', `/api/approvals/tasks/${task.id}/decide`, { action: 'approve' }, m2.cookie), 200)
  assert.equal(done.status, 'approved')
  // 已被 m2 认领，其他成员的待办里消失
  assert.equal((await myTasks(m1.cookie)).some((x) => x.instanceId === inst.id), false)
})

test('manager 型：沿 org_dept 找到上级；解析不出 → 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  await createFlow(DT.mgr, [{ no: 1, approver_type: 'manager', mode: 'any' }])
  // 部门「销售部」，负责人 = ownerA；m1 属于该部门
  const deptId = randomUUID()
  const now = new Date()
  const tctx = { tenantId: tenantAId, requestId: 'test' }
  await exec(
    tctx,
    `INSERT INTO org_dept (tenant_id, id, parent_id, name, path, manager_user_id, created_at, updated_at, version)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $6, 1)`,
    [tenantAId, deptId, `D${run}`, `/D${run}`, ownerA.id, now],
  )
  await exec(
    tctx,
    `INSERT INTO org_dept_member (tenant_id, id, dept_id, user_id, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [tenantAId, randomUUID(), deptId, m1.id, now],
  )

  const inst = await expectStatus(await submit(DT.mgr, '100.00', m1.cookie), 201)
  const task = (await myTasks(cookieA)).find((x) => x.instanceId === inst.id)
  assert.ok(task, '上级 ownerA 应收到任务')
  const done = await expectStatus(await call('POST', `/api/approvals/tasks/${task.id}/decide`, { action: 'approve' }, cookieA), 200)
  assert.equal(done.status, 'approved')

  // m2 不在任何部门 → 409，而不是生成无人可批的审批单
  const bad = await expectStatus(await submit(DT.mgr, '100.00', m2.cookie), 409)
  assert.match(String(bad.error.message), /部门|上级/)
})

test('非法跳转 409（带 allowed）与越权 403、拒绝回调', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  await createFlow(DT.reject, [
    { no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any' },
    { no: 2, approver_type: 'user', approver_ref: m2.id, mode: 'any' },
  ])

  // 越权：m3 不是审批人
  const inst = await expectStatus(await submit(DT.reject, '700.00'), 201)
  const task1 = (await myTasks(m1.cookie)).find((x) => x.instanceId === inst.id)
  const forbidden = await expectStatus(
    await call('POST', `/api/approvals/tasks/${task1.id}/decide`, { action: 'approve' }, m3.cookie),
    403,
  )
  assert.equal(forbidden.error.code, 'forbidden')

  // 拒绝 → instance rejected + onRejected
  const rejected = await expectStatus(
    await call('POST', `/api/approvals/tasks/${task1.id}/decide`, { action: 'reject', comment: '金额不对' }, m1.cookie),
    200,
  )
  assert.equal(rejected.status, 'rejected')
  assert.ok(hookCalls.some((c) => c.action === 'reject' && c.docId === inst.docId), 'onRejected 应被调用')

  // 已 rejected 的审批单再批 → 409 + allowed []
  const again = await expectStatus(await call('POST', `/api/approvals/tasks/${task1.id}/decide`, { action: 'approve' }, m1.cookie), 409)
  assert.deepEqual(again.error.details.allowed, [])
  assert.equal((await myTasks(m1.cookie)).some((x) => x.instanceId === inst.id), false)
})

test('跨租户一律 404', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const flow = await createFlow(DT.cross, [
    { no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any' },
    { no: 2, approver_type: 'user', approver_ref: m2.id, mode: 'any' },
  ])

  await expectStatus(await callB('GET', `/api/approval/flows/${flow.id}`), 404)
  await expectStatus(await callB('PATCH', `/api/approval/flows/${flow.id}`, { name: '偷改' }), 404)

  const inst = await expectStatus(await submit(DT.cross, '100.00'), 201)
  const task = (await myTasks(m1.cookie)).find((x) => x.instanceId === inst.id)
  await expectStatus(await callB('POST', `/api/approvals/tasks/${task.id}/decide`, { action: 'approve' }, cookieB), 404)
  await expectStatus(await callB('POST', `/api/approvals/${inst.id}/withdraw`, undefined, cookieB), 404)
  assert.equal((await myTasksB(cookieB)).length, 0)
})

test('撤回：提交人可撤回；非提交人 403', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const inst = await expectStatus(await submit(DT.serial, '900.00', m1.cookie), 201)

  await expectStatus(await call('POST', `/api/approvals/${inst.id}/withdraw`, undefined, cookieA), 403)

  const out = await expectStatus(await call('POST', `/api/approvals/${inst.id}/withdraw`, undefined, m1.cookie), 200)
  assert.equal(out.status, 'withdrawn')
  assert.ok(out.finishedAt)
  assert.equal((await myTasks(m1.cookie)).some((x) => x.instanceId === inst.id), false)

  // 已撤回再撤 → 409
  const again = await expectStatus(await call('POST', `/api/approvals/${inst.id}/withdraw`, undefined, m1.cookie), 409)
  assert.deepEqual(again.error.details.allowed, [])
})

test('转办：原任务 delegated，新审批人可批并推进到下一级', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const inst = await expectStatus(await submit(DT.serial, '1200.00'), 201)
  const task1 = (await myTasks(m1.cookie)).find((x) => x.instanceId === inst.id)
  await expectStatus(await call('POST', `/api/approvals/tasks/${task1.id}/delegate`, { toUserId: m3.id }, m1.cookie), 200)

  // 原审批人待办里没了，新审批人有了
  assert.equal((await myTasks(m1.cookie)).some((x) => x.instanceId === inst.id), false)
  const delegated = (await myTasks(m3.cookie)).find((x) => x.instanceId === inst.id)
  assert.ok(delegated)
  assert.equal(delegated.approverUserId, m3.id)

  // 原任务再批 → 409
  await expectStatus(await call('POST', `/api/approvals/tasks/${task1.id}/decide`, { action: 'approve' }, m1.cookie), 409)

  const moved = await expectStatus(
    await call('POST', `/api/approvals/tasks/${delegated.id}/decide`, { action: 'approve' }, m3.cookie),
    200,
  )
  assert.equal(moved.currentStep, 2)
  // 转办给非成员 → 400
  const task2 = (await myTasks(m2.cookie)).find((x) => x.instanceId === inst.id)
  await expectStatus(
    await call('POST', `/api/approvals/tasks/${task2.id}/delegate`, { toUserId: randomUUID() }, m2.cookie),
    400,
  )
})

test('无可用 flow → 409（不静默放行）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const body = await expectStatus(await submit(DT.none, '100.00'), 409)
  assert.equal(body.error.code, 'conflict')
  assert.match(String(body.error.message), /没有可用的审批流程/)
})

test('未知字段 400（流程 / 步骤 / 提交 / 审批动作）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  await expectStatus(
    await call('POST', '/api/approval/flows', {
      code: `F-BAD-${run}`,
      name: '坏流程',
      docType: DT.none,
      steps: [{ no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any' }],
      tenantId: '想偷偷指定租户',
    }),
    400,
  )
  await expectStatus(
    await call('POST', '/api/approval/flows', {
      code: `F-BAD2-${run}`,
      name: '坏步骤',
      docType: DT.none,
      steps: [{ no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any', formula: '${amount > 1}' }],
    }),
    400,
  )
  await expectStatus(
    await call('POST', '/api/approvals', { docType: DT.serial, docId: randomUUID(), amount: '1.00', bypass: true }),
    400,
  )
  await expectStatus(await call('POST', '/api/approvals', { docType: DT.serial, docId: 'not-a-uuid', amount: '1.00' }), 400)
  await expectStatus(await call('POST', '/api/approvals/tasks/00000000-0000-0000-0000-000000000000/decide', { action: 'approve', evil: 1 }), 400)

  // steps 空数组 / 重复 no / min>=max 也是 400
  await expectStatus(
    await call('POST', '/api/approval/flows', { code: `F-BAD3-${run}`, name: '空步骤', docType: DT.none, steps: [] }),
    400,
  )
  await expectStatus(
    await call('POST', '/api/approval/flows', {
      code: `F-BAD4-${run}`,
      name: '重复级',
      docType: DT.none,
      steps: [
        { no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any' },
        { no: 1, approver_type: 'user', approver_ref: m2.id, mode: 'any' },
      ],
    }),
    400,
  )
  await expectStatus(
    await call('POST', '/api/approval/flows', {
      code: `F-BAD5-${run}`,
      name: '金额区间反了',
      docType: DT.none,
      steps: [{ no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any', min_amount: '100.00', max_amount: '10.00' }],
    }),
    400,
  )
})

test('流程定义 CRUD：编码唯一 + PATCH 走版本号', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const flow = await createFlow(DT.crud, [{ no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any' }])
  assert.equal(flow.code, `F-${DT.crud}-X`)
  assert.deepEqual(flow.steps[0], {
    no: 1,
    approverType: 'user',
    approverRef: m1.id,
    mode: 'any',
    minAmount: null,
    maxAmount: null,
  })

  // 编码重复（大小写不敏感：normCode 统一大写）→ 409
  await expectStatus(
    await call('POST', '/api/approval/flows', {
      code: `f-${DT.crud}-x`,
      name: '重复编码',
      docType: DT.crud,
      steps: [{ no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any' }],
    }),
    409,
  )

  const patched = await expectStatus(
    await call('PATCH', `/api/approval/flows/${flow.id}`, { enabled: false, version: flow.version }),
    200,
  )
  assert.equal(patched.enabled, false)
  assert.equal(patched.version, flow.version + 1)

  // 旧版本号 → 409
  await expectStatus(await call('PATCH', `/api/approval/flows/${flow.id}`, { name: '过期版本', version: flow.version }), 409)

  // 列表 + 过滤
  const list = await expectStatus(await call('GET', `/api/approval/flows?docType=${DT.crud}&enabled=false`), 200)
  const items = /** @type {any[]} */ (list.items)
  assert.ok(items.some((x) => x.id === flow.id))
  assert.ok(items.every((x) => x.enabled === false))
})

test('在途单据用提交时的快照，流程后改不影响', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const flow = await createFlow(DT.snap, [
    { no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any' },
    { no: 2, approver_type: 'user', approver_ref: m2.id, mode: 'any' },
  ])

  const inst = await expectStatus(await submit(DT.snap, '2000.00'), 201)
  // 把流程改成只剩一级
  const patched = await expectStatus(
    await call('PATCH', `/api/approval/flows/${flow.id}`, {
      steps: [{ no: 1, approver_type: 'user', approver_ref: m1.id, mode: 'any' }],
      version: flow.version,
    }),
    200,
  )
  assert.equal(patched.steps.length, 1)

  const task1 = (await myTasks(m1.cookie)).find((x) => x.instanceId === inst.id)
  const after1 = await expectStatus(await call('POST', `/api/approvals/tasks/${task1.id}/decide`, { action: 'approve' }, m1.cookie), 200)
  assert.equal(after1.currentStep, 2, '快照里仍有第 2 级')
  assert.equal(after1.steps.length, 2)
  const task2 = (await myTasks(m2.cookie)).find((x) => x.instanceId === inst.id)
  assert.ok(task2, '第 2 级任务仍应生成')
  assert.equal((await expectStatus(await call('POST', `/api/approvals/tasks/${task2.id}/decide`, { action: 'approve' }, m2.cookie), 200)).status, 'approved')
})

test('同名单据重复提交 → 409（在途去重）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  const docId = randomUUID()
  const first = await expectStatus(await call('POST', '/api/approvals', { docType: DT.serial, docId, amount: '10.00' }), 201)
  assert.equal(first.status, 'pending')
  await expectStatus(await call('POST', '/api/approvals', { docType: DT.serial, docId, amount: '10.00' }), 409)
  // 事件流水可查
  const events = await expectStatus(await call('GET', `/api/approvals/${first.id}/events`), 200)
  assert.deepEqual(/** @type {any[]} */ (events.items).map((e) => e.action), ['submit'])
})
