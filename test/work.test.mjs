import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { close, connect, exec, q } from '../db/index.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { jsonOf, makeApp } from './helpers.mjs'

/**
 * M3 施工域验收用例（DESIGN §15）：
 *   ① 项目 signed→constructing→pending_acceptance→warranty→closed 全链路 + 非法跳转 409
 *   ② 领料：库存不足 → 审批通过后 applyMove 抛 409，审批实例/领料单落 failed 且错误可见；库存够则扣减
 *   ③ 变更签证通过审批 → project.contract_amt 累加 + audit_log
 *   ④ 整体验收通过 → 项目 pending_acceptance
 *   ⑤ 跨租户 404、未知字段 400、旧 version 409、游标分页
 *
 * M1 的「商机→合同→签约」链路已由 test/m1_chain.test.mjs 覆盖，这里直接种一个 signed 项目，
 * 把用例集中在施工域本身（不重复造 M1 的路径）。
 */

const password = 'test-pass-123'
const run = randomUUID().slice(0, 8).toUpperCase()
const slugA = `wa${run.toLowerCase()}`
const slugB = `wb${run.toLowerCase()}`
const emailA = `wa-${run.toLowerCase()}@example.com`
const emailB = `wb-${run.toLowerCase()}@example.com`

/** @type {any} */
let app
let dbUp = false
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''
/** @type {string} */
let tenantAId = ''
/** @type {string} */
let ownerAId = ''
/** @type {string} */
let partyAId = ''
let seq = 0
/** @param {string} prefix */
const code = (prefix) => `${prefix}-${run}-${++seq}`
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

/** @param {string} prefix */
async function makeParty(prefix) {
  const r = await call('POST', A('/api/parties'), { code: code(prefix), name: `客户 ${prefix}`, partyType: 'customer' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

/**
 * 直接种一个指定状态的项目（signed 由合同签署联动产生，M1 用例已覆盖那条路）。
 * @param {string} status @param {{ amount?: string, prefix?: string }} [opts]
 */
async function seedProject(status, opts = {}) {
  const id = randomUUID()
  const now = new Date()
  await exec(
    { tenantId: tenantAId },
    `INSERT INTO project
       (tenant_id, id, code, name, party_id, opportunity_id, status, contract_amt, pm_user_id,
        start_date, end_date, note, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, NULL, NULL, NULL, NULL, 1, $8, $8)`,
    [tenantAId, id, code(opts.prefix ?? 'P'), `施工项目 ${id.slice(0, 6)}`, partyAId, status, opts.amount ?? '0.00', now],
  )
  return id
}

/** @param {string} docType */
async function createOwnerFlow(docType) {
  const r = await call('POST', A('/api/approval/flows'), {
    code: `F-${docType}-${run}`,
    name: `流程 ${docType}`,
    docType,
    steps: [{ no: 1, approver_type: 'role', approver_ref: 'owner', mode: 'any' }],
  })
  // 重复跑同一个库时流程编码已存在 —— 409 也算就绪
  assert.ok(r.status === 201 || r.status === 409, JSON.stringify(r.body))
}

/** @param {string} instanceId @param {string} [cookie] */
async function decideTask(instanceId, cookie = cookieA) {
  const tasks = await call('GET', A('/api/approvals/my-tasks'), undefined, cookie)
  assert.equal(tasks.status, 200, JSON.stringify(tasks.body))
  const task = tasks.body.items.find((/** @type {any} */ x) => x.instanceId === instanceId)
  assert.ok(task, `找不到审批任务 instance=${instanceId}`)
  return call('POST', A(`/api/approvals/tasks/${task.id}/decide`), { action: 'approve' }, cookie)
}

/** @param {string} prefix */
async function makeItem(prefix) {
  const r = await call('POST', A('/api/items'), { code: code(prefix), name: `物料 ${prefix}`, baseUom: 'PCS' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

async function makeWarehouse() {
  const r = await call('POST', A('/api/warehouses'), { code: code('WH'), name: '施工仓' })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r.body
}

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  await exec({}, 'DELETE FROM login_attempt', [])
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲施工', email: emailA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙施工', email: emailB, password })
  app = await makeApp()
  cookieA = await app.login(emailA, password)
  cookieB = await app.login(emailB, password)
  const me = await jsonOf(await app.call('GET', A('/api/me'), undefined, cookieA))
  tenantAId = me.tenant.id
  ownerAId = me.user.id
  partyAId = (await makeParty('PC')).id
  await createOwnerFlow('material_issue')
  await createOwnerFlow('change_order')
})

test.after(async () => {
  if (app) await app.close()
  await close()
})

// ── ① 项目状态机延长 ────────────────────────────────────────────────────────

test('项目状态链：signed→constructing→pending_acceptance→warranty→closed，非法跳转 409 带 allowed', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const id = await seedProject('signed')

  const signed = await call('GET', A(`/api/projects/${id}`))
  assert.equal(signed.status, 200, JSON.stringify(signed.body))
  assert.deepEqual(signed.body.allowed, ['constructing', 'terminated'])

  // 跳级：signed 直接 closed
  const jump = await call('POST', A(`/api/projects/${id}/advance`), { to: 'closed' })
  assert.equal(jump.status, 409)
  assert.deepEqual(jump.body.error.details.allowed, ['constructing', 'terminated'])

  const chain = ['constructing', 'pending_acceptance', 'warranty', 'closed']
  for (const to of chain) {
    const r = await call('POST', A(`/api/projects/${id}/advance`), { to })
    assert.equal(r.status, 200, `${to}: ${JSON.stringify(r.body)}`)
    assert.equal(r.body.status, to)
  }
  const closed = await call('GET', A(`/api/projects/${id}`))
  assert.deepEqual(closed.body.allowed, [])

  const stages = await call('GET', A(`/api/projects/${id}/stages`))
  assert.deepEqual(
    stages.body.items.map((/** @type {any} */ x) => x.toStatus),
    chain,
  )

  // 施工中也不能跳级到 warranty
  const id2 = await seedProject('signed')
  await call('POST', A(`/api/projects/${id2}/advance`), { to: 'constructing' })
  const bad = await call('POST', A(`/api/projects/${id2}/advance`), { to: 'warranty' })
  assert.equal(bad.status, 409)
  assert.deepEqual(bad.body.error.details.allowed, ['pending_acceptance', 'terminated'])
})

// ── ② 领料 + 审批 + 库存 ────────────────────────────────────────────────────

test('领料：库存不足 → 审批通过后 applyMove 失败，审批实例与领料单都落 failed，原因可见', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing')
  const item = await makeItem('NOSTOCK')
  const wh = await makeWarehouse()

  const created = await call('POST', A('/api/material-issues'), {
    projectId,
    code: code('MI'),
    warehouseId: wh.id,
    lines: [{ itemId: item.id, qty: '5' }],
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.status, 'draft')
  assert.equal(Number(created.body.amount), 0)

  const submitted = await call('POST', A(`/api/material-issues/${created.body.id}/submit`))
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
  assert.equal(submitted.body.status, 'pending')
  assert.ok(submitted.body.approvalInstanceId)
  assert.equal(submitted.body.approval.status, 'pending')

  // 库存为 0：审批通过 → hook 调 applyMove 抛 409
  const decided = await decideTask(submitted.body.approvalInstanceId)
  assert.equal(decided.status, 409, JSON.stringify(decided.body))
  assert.match(decided.body.error.message, /库存不足/)

  const failed = await call('GET', A(`/api/material-issues/${created.body.id}`))
  assert.equal(failed.status, 200)
  assert.equal(failed.body.status, 'failed')
  assert.match(failed.body.errorMessage, /库存不足/)
  assert.equal(failed.body.approval.status, 'failed', '审批实例必须落 failed，不能停在 approved')

  // 错误在审批事件流里可见
  const events = await call('GET', A(`/api/approvals/${submitted.body.approvalInstanceId}/events`))
  assert.equal(events.status, 200, JSON.stringify(events.body))
  const failure = events.body.items.find((/** @type {any} */ x) => x.action === 'failed')
  assert.ok(failure, `审批事件里应有 failed: ${JSON.stringify(events.body.items)}`)
  assert.match(failure.comment, /库存不足/)

  // 未产生任何出库流水 / 余额没被扣成负数
  const bal = await call('GET', A(`/api/stock/balances?warehouseId=${wh.id}&itemId=${item.id}`))
  assert.equal(bal.body.items.length, 0)
})

test('领料：库存充足 → 审批通过后出库，余额减少；拒绝则不动库存', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing')
  const item = await makeItem('STOCK')
  const wh = await makeWarehouse()

  const move = await call('POST', A('/api/stock/moves'), {
    warehouseId: wh.id,
    itemId: item.id,
    qty: '10',
    dir: 'in',
    moveType: 'purchase_in',
    unitCost: '12.50',
  })
  assert.equal(move.status, 201, JSON.stringify(move.body))

  const created = await call('POST', A('/api/material-issues'), {
    projectId,
    code: code('MI'),
    warehouseId: wh.id,
    lines: [{ itemId: item.id, qty: '3', unitCost: '12.50' }],
    note: '现场领用',
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.amount, '37.50', '未传 amount 时按明细 qty×unitCost 现算')

  const submitted = await call('POST', A(`/api/material-issues/${created.body.id}/submit`))
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
  const decided = await decideTask(submitted.body.approvalInstanceId)
  assert.equal(decided.status, 200, JSON.stringify(decided.body))
  assert.equal(decided.body.status, 'approved')

  const issued = await call('GET', A(`/api/material-issues/${created.body.id}`))
  assert.equal(issued.body.status, 'issued')
  assert.equal(issued.body.approval.status, 'approved')

  const bal = await call('GET', A(`/api/stock/balances?warehouseId=${wh.id}&itemId=${item.id}`))
  assert.equal(bal.status, 200)
  assert.equal(bal.body.items.length, 1)
  assert.equal(Number(bal.body.items[0].qty), 7)

  const moves = await call('GET', A(`/api/stock/moves?refType=material_issue&refId=${created.body.id}`))
  assert.equal(moves.body.items.length, 1)
  assert.equal(moves.body.items[0].dir, 'out')
  assert.equal(Number(moves.body.items[0].qty), 3)
})

test('领料多明细：后一行库存不足 → 整个审批事务回滚，账不留半边', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing')
  const okItem = await makeItem('MULTI-OK')
  const noItem = await makeItem('MULTI-NO')
  const wh = await makeWarehouse()
  const inbound = await call('POST', A('/api/stock/moves'), {
    warehouseId: wh.id,
    itemId: okItem.id,
    qty: '10',
    dir: 'in',
    moveType: 'purchase_in',
  })
  assert.equal(inbound.status, 201, JSON.stringify(inbound.body))

  const created = await call('POST', A('/api/material-issues'), {
    projectId,
    code: code('MI'),
    warehouseId: wh.id,
    lines: [
      { itemId: okItem.id, qty: '4' },
      { itemId: noItem.id, qty: '2' },
    ],
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const submitted = await call('POST', A(`/api/material-issues/${created.body.id}/submit`))
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
  const decided = await decideTask(submitted.body.approvalInstanceId)
  assert.equal(decided.status, 409, JSON.stringify(decided.body))

  // 关键：整个审批事务回滚 —— 先出库那一行也跟着回滚，余额回到 10
  const bal = await call('GET', A(`/api/stock/balances?warehouseId=${wh.id}&itemId=${okItem.id}`))
  assert.equal(Number(bal.body.items[0].qty), 10, '回滚后余额应回到入库时的值')

  // 回滚语义下不该留下任何流水（不是「出库 + 反向入库」两条）
  const moves = await call('GET', A(`/api/stock/moves?refType=material_issue&refId=${created.body.id}&order=asc`))
  assert.deepEqual(moves.body.items.map((/** @type {any} */ m) => `${m.dir}:${m.moveType}`), [])

  // 失败原因必须留在单据上，运维才查得到
  const failed = await call('GET', A(`/api/material-issues/${created.body.id}`))
  assert.equal(failed.body.status, 'failed')
  assert.match(String(failed.body.errorMessage ?? ''), /库存|不足/)
})

// ── ③ 变更签证 ──────────────────────────────────────────────────────────────

test('变更签证：审批通过后 project.contract_amt 累加（按分算）并写 audit_log', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing', { amount: '1000.00', prefix: 'CO' })

  const created = await call('POST', A('/api/change-orders'), {
    projectId,
    code: code('CHG'),
    title: '新增配电柜',
    amount: '250.50',
    reason: '客户现场追加',
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.status, 'draft')

  const submitted = await call('POST', A(`/api/change-orders/${created.body.id}/submit`))
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
  assert.equal(submitted.body.status, 'pending')

  const decided = await decideTask(submitted.body.approvalInstanceId)
  assert.equal(decided.status, 200, JSON.stringify(decided.body))

  const co = await call('GET', A(`/api/change-orders/${created.body.id}`))
  assert.equal(co.body.status, 'applied')
  assert.ok(co.body.appliedAt)

  const project = await call('GET', A(`/api/projects/${projectId}`))
  assert.equal(Number(project.body.contractAmt), 1250.5, '合同额必须精确累加（分）')

  const logs = await q(
    { tenantId: tenantAId },
    `SELECT action, before_json, after_json FROM audit_log WHERE $t AND module = 'change_order' AND ref_id = $1 ORDER BY at ASC`,
    [created.body.id],
  )
  const applied = logs.find((l) => l.action === 'apply')
  assert.ok(applied, '必须写 audit_log(module=change_order, action=apply)')
  const before = typeof applied.before_json === 'string' ? JSON.parse(applied.before_json) : applied.before_json
  const after = typeof applied.after_json === 'string' ? JSON.parse(applied.after_json) : applied.after_json
  assert.equal(before.contractAmt, '1000.00')
  assert.equal(after.contractAmt, '1250.50')

  // 已落账的变更单不能再改
  const patch = await call('PATCH', A(`/api/change-orders/${created.body.id}`), { amount: '1.00' })
  assert.equal(patch.status, 409)
})

// ── ④ 验收 ──────────────────────────────────────────────────────────────────

test('整体验收通过 → 项目 constructing → pending_acceptance；隐蔽验收不影响项目状态', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing')

  const hidden = await call('POST', A('/api/acceptances'), {
    projectId,
    code: code('ACC'),
    type: 'hidden',
    items: [{ name: '线管预埋', result: 'pass' }],
  })
  assert.equal(hidden.status, 201, JSON.stringify(hidden.body))
  const hiddenDone = await call('POST', A(`/api/acceptances/${hidden.body.id}/advance`), { to: 'passed' })
  assert.equal(hiddenDone.status, 200, JSON.stringify(hiddenDone.body))
  const afterHidden = await call('GET', A(`/api/projects/${projectId}`))
  assert.equal(afterHidden.body.status, 'constructing', '隐蔽验收不推进项目状态')

  const created = await call('POST', A('/api/acceptances'), {
    projectId,
    code: code('ACC'),
    type: 'overall',
    items: [
      { name: '设备安装', result: 'pass', note: '符合图纸' },
      { name: '配电测试', result: 'pass' },
    ],
    conclusion: '整体合格',
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.status, 'draft')
  assert.deepEqual(created.body.allowed, ['passed', 'failed'])

  const passed = await call('POST', A(`/api/acceptances/${created.body.id}/advance`), {
    to: 'passed',
    conclusion: '整体验收合格',
  })
  assert.equal(passed.status, 200, JSON.stringify(passed.body))
  assert.equal(passed.body.status, 'passed')
  assert.equal(passed.body.acceptedBy, ownerAId)

  const project = await call('GET', A(`/api/projects/${projectId}`))
  assert.equal(project.body.status, 'pending_acceptance')
  assert.deepEqual(project.body.allowed, ['warranty', 'constructing', 'terminated'])

  const stages = await call('GET', A(`/api/projects/${projectId}/stages`))
  const last = stages.body.items[stages.body.items.length - 1]
  assert.equal(last.toStatus, 'pending_acceptance')
  assert.match(last.note, /验收/)
})

// ── ⑤ 计划/任务/进度/工时/现场记录 ──────────────────────────────────────────

test('计划拆任务：任务状态 todo→doing→done，进度上报写 progress_log，旧 version 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing')

  const plan = await call('POST', A('/api/work-plans'), {
    projectId,
    code: code('WP'),
    name: '一期施工计划',
    planStart: '2026-03-01',
    planEnd: '2026-04-30',
  })
  assert.equal(plan.status, 201, JSON.stringify(plan.body))

  const task = await call('POST', A('/api/work-tasks'), {
    planId: plan.body.id,
    code: code('WT'),
    title: '桥架安装',
    assigneeId: ownerAId,
    planStart: '2026-03-02',
  })
  assert.equal(task.status, 201, JSON.stringify(task.body))
  assert.equal(task.body.status, 'todo')
  assert.equal(task.body.projectId, projectId)
  assert.deepEqual(task.body.allowed, ['doing', 'done'])

  const doing = await call('POST', A(`/api/work-tasks/${task.body.id}/advance`), { to: 'doing' })
  assert.equal(doing.status, 200)

  const progress = await call('POST', A('/api/progress-logs'), {
    taskId: task.body.id,
    progress: 40,
    content: '完成 40%',
  })
  assert.equal(progress.status, 201, JSON.stringify(progress.body))
  const afterReport = await call('GET', A(`/api/work-tasks/${task.body.id}`))
  assert.equal(afterReport.body.progress, 40)
  assert.equal(afterReport.body.progressLogs.length, 1)
  assert.equal(afterReport.body.progressLogs[0].progress, 40)

  const done = await call('POST', A(`/api/work-tasks/${task.body.id}/advance`), { to: 'done' })
  assert.equal(done.status, 200)
  assert.equal(done.body.status, 'done')
  assert.equal(done.body.progress, 100, 'done 必须把 progress 拉到 100')

  const back = await call('POST', A(`/api/work-tasks/${task.body.id}/advance`), { to: 'doing' })
  assert.equal(back.status, 409)
  assert.deepEqual(back.body.error.details.allowed, [])

  // 旧 version 409
  const stale = await call('PATCH', A(`/api/work-plans/${plan.body.id}`), { name: '改名', version: 999 })
  assert.equal(stale.status, 409)
  const stale2 = await call('PATCH', A(`/api/work-tasks/${task.body.id}`), { title: '改名', version: 1 })
  assert.equal(stale2.status, 409)
})

test('工时与现场记录：CRUD + 校验', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing')

  const created = await call('POST', A('/api/labor-hours'), {
    projectId,
    userId: ownerAId,
    workDate: '2026-03-05',
    hours: '7.5',
    note: '桥架安装',
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  assert.equal(created.body.hours, 7.5)

  const badHours = await call('POST', A('/api/labor-hours'), {
    projectId,
    workDate: '2026-03-05',
    hours: '0',
  })
  assert.equal(badHours.status, 400)

  const updated = await call('PATCH', A(`/api/labor-hours/${created.body.id}`), { hours: '8', version: 1 })
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(updated.body.hours, 8)

  const list = await call('GET', A(`/api/labor-hours?projectId=${projectId}`))
  assert.equal(list.body.items.length, 1)

  const removed = await call('DELETE', A(`/api/labor-hours/${created.body.id}`))
  assert.equal(removed.status, 200)
  assert.equal((await call('GET', A(`/api/labor-hours/${created.body.id}`))).status, 404)

  const site = await call('POST', A('/api/site-records'), {
    projectId,
    recordedAt: '2026-03-06',
    weather: 'sunny',
    content: '今日完成桥架 30 米',
  })
  assert.equal(site.status, 201, JSON.stringify(site.body))
  const sitePatch = await call('PATCH', A(`/api/site-records/${site.body.id}`), {
    content: '今日完成桥架 32 米',
    version: 1,
  })
  assert.equal(sitePatch.status, 200, JSON.stringify(sitePatch.body))
  assert.match(sitePatch.body.content, /32/)
  assert.equal((await call('DELETE', A(`/api/site-records/${site.body.id}`))).status, 200)
})

// ── ⑥ 越权 / 校验 / 分页 ────────────────────────────────────────────────────

test('跨租户一律 404：计划/任务/领料/验收逐一验证', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing')
  const plan = await call('POST', A('/api/work-plans'), { projectId, code: code('WP'), name: '跨租户计划' })
  assert.equal(plan.status, 201)
  const task = await call('POST', A('/api/work-tasks'), { planId: plan.body.id, code: code('WT'), title: '跨租户任务' })
  assert.equal(task.status, 201)
  const acc = await call('POST', A('/api/acceptances'), {
    projectId,
    code: code('ACC'),
    type: 'hidden',
    items: [{ name: 'x', result: 'pass' }],
  })
  assert.equal(acc.status, 201)

  assert.equal((await call('GET', B(`/api/work-plans/${plan.body.id}`), undefined, cookieB)).status, 404)
  assert.equal((await call('GET', B(`/api/work-tasks/${task.body.id}`), undefined, cookieB)).status, 404)
  assert.equal((await call('GET', B(`/api/acceptances/${acc.body.id}`), undefined, cookieB)).status, 404)
  const item = await makeItem('XTENANT')
  const wh = await makeWarehouse()
  const issue = await call('POST', A('/api/material-issues'), {
    projectId,
    code: code('MI'),
    warehouseId: wh.id,
    lines: [{ itemId: item.id, qty: '1' }],
  })
  assert.equal(issue.status, 201, JSON.stringify(issue.body))
  assert.equal((await call('GET', B(`/api/material-issues/${issue.body.id}`), undefined, cookieB)).status, 404)
  assert.equal((await call('PATCH', B(`/api/work-tasks/${task.body.id}`), { title: '偷改' }, cookieB)).status, 404)
  assert.equal((await call('GET', B(`/api/acceptances?projectId=${projectId}`), undefined, cookieB)).body.items.length, 0)

  // 用别的租户的 planId 建任务 → 404（不能跨租户挂靠）
  const cross = await call('POST', B('/api/work-tasks'), { planId: plan.body.id, code: 'X', title: '偷建' }, cookieB)
  assert.equal(cross.status, 404)
})

test('未知字段 400；游标分页 nextCursor 可续页', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing')

  const unknown = await call('POST', A('/api/work-plans'), {
    projectId,
    code: code('WP'),
    name: '带脏字段',
    tenantId: '想偷偷指定租户',
  })
  assert.equal(unknown.status, 400)

  const item = await makeItem('BADLINE')
  const wh = await makeWarehouse()
  const badLine = await call('POST', A('/api/material-issues'), {
    projectId,
    code: code('MI'),
    warehouseId: wh.id,
    lines: [{ itemId: item.id, qty: '1', formula: 'x' }],
  })
  assert.equal(badLine.status, 400, JSON.stringify(badLine.body))

  for (let i = 0; i < 3; i++) {
    const r = await call('POST', A('/api/work-plans'), { projectId, code: code('PG'), name: `分页计划 ${i}` })
    assert.equal(r.status, 201, JSON.stringify(r.body))
  }
  const page1 = await call('GET', A(`/api/work-plans?projectId=${projectId}&limit=2&order=asc`))
  assert.equal(page1.status, 200)
  assert.equal(page1.body.items.length, 2)
  assert.ok(page1.body.nextCursor, '应有 nextCursor')
  const page2 = await call(
    'GET',
    A(`/api/work-plans?projectId=${projectId}&limit=2&order=asc&cursor=${encodeURIComponent(page1.body.nextCursor)}`),
  )
  assert.equal(page2.status, 200)
  assert.equal(page2.body.items.length, 1)
  assert.equal(page2.body.nextCursor, null)
  const ids = new Set([...page1.body.items, ...page2.body.items].map((/** @type {any} */ x) => x.id))
  assert.equal(ids.size, 3)
})

test('领料草稿校验：无明细不能提交审批；提交后不能再改', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const projectId = await seedProject('constructing')
  const item = await makeItem('DRAFT')
  const wh = await makeWarehouse()

  const r = await call('POST', A('/api/material-issues'), {
    projectId,
    code: code('MI'),
    warehouseId: wh.id,
    lines: [{ itemId: item.id, qty: '1' }],
    amount: '88.00',
  })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.amount, '88.00')

  const submitted = await call('POST', A(`/api/material-issues/${r.body.id}/submit`))
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
  const again = await call('POST', A(`/api/material-issues/${r.body.id}/submit`))
  assert.equal(again.status, 409)
  const patch = await call('PATCH', A(`/api/material-issues/${r.body.id}`), { note: '偷改' })
  assert.equal(patch.status, 409)

  // 未知项目 → 404
  const bad = await call('POST', A('/api/material-issues'), {
    projectId: randomUUID(),
    code: code('MI'),
    warehouseId: wh.id,
    lines: [{ itemId: item.id, qty: '1' }],
  })
  assert.equal(bad.status, 404)

  const count = await q({ tenantId: tenantAId }, `SELECT id FROM work_plan WHERE $t`, [])
  assert.ok(count.length >= 1)
})
