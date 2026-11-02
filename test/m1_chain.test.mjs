import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { close, connect, exec } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'

/**
 * M1 验收硬门槛（DESIGN §15）：
 *   一条项目从商机一路走到签约，状态机不可跳级，全程双租户隔离，
 *   并且报价/合同的金额头与行合计必须自洽。
 */
const password = 'test-pass-123'
const slugA = `ca${Date.now().toString(36)}`
const slugB = `cb${Date.now().toString(36)}`
const emailA = `ca-${randomUUID().slice(0, 8)}@example.com`
const emailB = `cb-${randomUUID().slice(0, 8)}@example.com`

/** @type {any} */
let app
/** @type {string} */
let cookieA = ''
/** @type {string} */
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
  app = await makeApp()
  cookieA = await app.login(emailA, password)
  cookieB = await app.login(emailB, password)
})

test.after(async () => {
  if (app) await app.close()
})

const A = (/** @type {string} */ p) => `/t/${slugA}${p}`
const B = (/** @type {string} */ p) => `/t/${slugB}${p}`

/** @param {string} path @param {unknown} body */
const post = async (path, body) => {
  const res = await app.call('POST', path, body, cookieA)
  return { status: res.status, body: await jsonOf(res) }
}
/** @param {string} path */
const get = async (path) => {
  const res = await app.call('GET', path, undefined, cookieA)
  return { status: res.status, body: await jsonOf(res) }
}

test('一条项目走到签约：商机→立项→需求→BOM→报价→合同', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  // 客户
  const party = await post(A('/api/parties'), { code: `C${Date.now().toString(36)}`, name: '市政务云', partyType: 'customer' })
  assert.equal(party.status, 201, JSON.stringify(party.body))

  // 商机 new → following → won
  const opp = await post(A('/api/opportunities'), {
    code: `O${Date.now().toString(36)}`,
    name: '政务云集成',
    partyId: party.body.id,
    estAmount: 120000,
  })
  assert.equal(opp.status, 201, JSON.stringify(opp.body))
  assert.equal(opp.body.stage, 'new')

  assert.equal((await post(A(`/api/opportunities/${opp.body.id}/advance`), { to: 'following' })).status, 200)
  const won = await post(A(`/api/opportunities/${opp.body.id}/advance`), { to: 'won' })
  assert.equal(won.status, 200, JSON.stringify(won.body))
  assert.ok(won.body.project, 'won 必须同事务建出项目')
  const projectId = won.body.project.id
  assert.equal(won.body.project.status, 'draft')

  // 立项 → 设计中
  assert.equal((await post(A(`/api/projects/${projectId}/advance`), { to: 'approved' })).status, 200)
  assert.equal((await post(A(`/api/projects/${projectId}/advance`), { to: 'designing' })).status, 200)

  // 需求
  const req = await post(A('/api/requirements'), { projectId, title: '需求调研', content: '三层架构' })
  assert.equal(req.status, 201, JSON.stringify(req.body))
  assert.equal((await post(A(`/api/requirements/${req.body.id}/advance`), { to: 'confirmed' })).status, 200)

  // 方案 + BOM（两条）
  const doc = await post(A('/api/design-docs'), {
    projectId,
    title: '拓扑方案 v1',
    content: '核心双机',
    bomLines: [
      { lineNo: 1, itemName: '核心交换机', spec: '24口', uom: '台', qty: 2, unitCost: '5000.00' },
      { lineNo: 2, itemName: '接入交换机', spec: '48口', uom: '台', qty: 10, unitCost: '1000.00' },
    ],
  })
  assert.equal(doc.status, 201, JSON.stringify(doc.body))
  assert.equal((await post(A(`/api/design-docs/${doc.body.id}/advance`), { to: 'confirmed' })).status, 200)

  // 进入报价中（项目状态机 designing→quoting），业务上就是"开始报价"这个动作
  assert.equal((await post(A(`/api/projects/${projectId}/advance`), { to: 'quoting' })).status, 200)

  // 报价：从 BOM 快照 → 2×5000 + 10×1000 = 20000
  const quo = await post(A('/api/quotations'), { designDocId: doc.body.id })
  assert.equal(quo.status, 201, JSON.stringify(quo.body))
  assert.equal(Number(quo.body.amount), 20000)

  const quoDetail = await get(A(`/api/quotations/${quo.body.id}`))
  assert.equal(quoDetail.body.lines.length, 2)
  const lineSum = quoDetail.body.lines.reduce((/** @type {number} */ s, /** @type {any} */ l) => s + Number(l.amount), 0)
  assert.equal(lineSum, Number(quoDetail.body.amount), '报价头金额必须等于行合计')

  assert.equal((await post(A(`/api/quotations/${quo.body.id}/advance`), { to: 'sent' })).status, 200)
  assert.equal((await post(A(`/api/quotations/${quo.body.id}/advance`), { to: 'accepted' })).status, 200)

  // 合同：从报价快照 → 签约
  const con = await post(A('/api/contracts'), {
    quotationId: quo.body.id,
    code: `HT${Date.now().toString(36)}`,
    name: '政务云集成合同',
    terms: [
      { title: '总价', content: '含税 2 万' },
      { title: '质保', content: '一年' },
    ],
  })
  assert.equal(con.status, 201, JSON.stringify(con.body))
  assert.equal(Number(con.body.amount), 20000, '合同金额应继承报价')

  const conDetail = await get(A(`/api/contracts/${con.body.id}`))
  assert.equal(conDetail.body.lines.length, 2)
  assert.equal(conDetail.body.terms.length, 2)
  const conSum = conDetail.body.lines.reduce((/** @type {number} */ s, /** @type {any} */ l) => s + Number(l.amount), 0)
  assert.equal(conSum, Number(conDetail.body.amount), '合同头金额必须等于行合计')

  const signed = await post(A(`/api/contracts/${con.body.id}/advance`), { to: 'signed' })
  assert.equal(signed.status, 200, JSON.stringify(signed.body))

  // 项目被推到 signed，且历史完整
  const proj = await get(A(`/api/projects/${projectId}`))
  assert.equal(proj.body.status, 'signed')

  const stages = await get(A(`/api/projects/${projectId}/stages`))
  const seq = (stages.body.items ?? stages.body).map((/** @type {any} */ s) => s.toStatus ?? s.to_status)
  assert.deepEqual(seq, ['draft', 'approved', 'designing', 'quoting', 'signed'], `状态历史不完整: ${JSON.stringify(seq)}`)
})

test('状态机不可跳级：每一处非法跳转都 409 且带 allowed', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await post(A('/api/parties'), { code: `CJ${Date.now().toString(36)}`, name: '跳级测试', partyType: 'customer' })
  const opp = await post(A('/api/opportunities'), {
    code: `OJ${Date.now().toString(36)}`,
    name: '跳级商机',
    partyId: party.body.id,
    estAmount: 1,
  })

  // 商机 new 不能直接 won
  const jump = await post(A(`/api/opportunities/${opp.body.id}/advance`), { to: 'won' })
  assert.equal(jump.status, 409)
  assert.deepEqual(jump.body.error.details.allowed.sort(), ['following', 'lost'])

  // 立项后不能从 approved 直接 signed
  await post(A(`/api/opportunities/${opp.body.id}/advance`), { to: 'following' })
  const won = await post(A(`/api/opportunities/${opp.body.id}/advance`), { to: 'won' })
  const pid = won.body.project.id
  await post(A(`/api/projects/${pid}/advance`), { to: 'approved' })
  const pjump = await post(A(`/api/projects/${pid}/advance`), { to: 'signed' })
  assert.equal(pjump.status, 409)
  assert.ok(pjump.body.error.details.allowed.includes('designing'))

  // 报价 draft 不能直接 accepted（需要一个方案）
  await post(A(`/api/projects/${pid}/advance`), { to: 'designing' })
  const doc = await post(A('/api/design-docs'), {
    projectId: pid,
    title: 'v1',
    bomLines: [{ lineNo: 1, itemName: 'X', qty: 1, unitCost: '1.00' }],
  })
  await post(A(`/api/design-docs/${doc.body.id}/advance`), { to: 'confirmed' })
  const quo = await post(A('/api/quotations'), { designDocId: doc.body.id })
  const qjump = await post(A(`/api/quotations/${quo.body.id}/advance`), { to: 'accepted' })
  assert.equal(qjump.status, 409)
  assert.deepEqual(qjump.body.error.details.allowed, ['sent'])
})

test('项目没进「报价中」就签合同 → 409（不靠约定，靠状态机兜）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await post(A('/api/parties'), { code: `CS${Date.now().toString(36)}`, name: '跳签', partyType: 'customer' })
  const opp = await post(A('/api/opportunities'), {
    code: `OS${Date.now().toString(36)}`,
    name: '跳签商机',
    partyId: party.body.id,
    estAmount: 1,
  })
  await post(A(`/api/opportunities/${opp.body.id}/advance`), { to: 'following' })
  const won = await post(A(`/api/opportunities/${opp.body.id}/advance`), { to: 'won' })
  const pid = won.body.project.id
  await post(A(`/api/projects/${pid}/advance`), { to: 'approved' })
  await post(A(`/api/projects/${pid}/advance`), { to: 'designing' })
  // 项目还停在 designing，直接造一张已接受的报价并签约
  const doc = await post(A('/api/design-docs'), {
    projectId: pid,
    title: 'v1',
    bomLines: [{ lineNo: 1, itemName: 'X', qty: 1, unitCost: '1.00' }],
  })
  await post(A(`/api/design-docs/${doc.body.id}/advance`), { to: 'confirmed' })
  const quo = await post(A('/api/quotations'), { designDocId: doc.body.id })
  await post(A(`/api/quotations/${quo.body.id}/advance`), { to: 'sent' })
  await post(A(`/api/quotations/${quo.body.id}/advance`), { to: 'accepted' })
  const con = await post(A('/api/contracts'), {
    quotationId: quo.body.id,
    code: `HTS${Date.now().toString(36)}`,
    name: '跳签合同',
  })
  const sign = await post(A(`/api/contracts/${con.body.id}/advance`), { to: 'signed' })
  assert.equal(sign.status, 409, JSON.stringify(sign.body))
  assert.ok(sign.body.error.details.allowed.includes('signed') === false, '项目 designing 不许直接 signed')

  const proj = await get(A(`/api/projects/${pid}`))
  assert.equal(proj.body.status, 'designing', '签约被拒后项目状态不能变')
})

test('跨租户：B 拿着整条链的 id 逐个访问都 404', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const party = await post(A('/api/parties'), { code: `CX${Date.now().toString(36)}`, name: '隔离', partyType: 'customer' })
  const opp = await post(A('/api/opportunities'), {
    code: `OX${Date.now().toString(36)}`,
    name: '隔离商机',
    partyId: party.body.id,
    estAmount: 1,
  })
  await post(A(`/api/opportunities/${opp.body.id}/advance`), { to: 'following' })
  const won = await post(A(`/api/opportunities/${opp.body.id}/advance`), { to: 'won' })
  const pid = won.body.project.id

  const paths = [`/api/opportunities/${opp.body.id}`, `/api/projects/${pid}`, `/api/projects/${pid}/stages`]
  for (const p of paths) {
    const res = await app.call('GET', B(p), undefined, cookieB)
    assert.equal(res.status, 404, `${p} 应 404，实际 ${res.status}`)
  }

  // 列表也不能漏
  const listB = await jsonOf(await app.call('GET', B('/api/projects'), undefined, cookieB))
  assert.ok(!listB.items.some((/** @type {any} */ p) => p.id === pid))
})
