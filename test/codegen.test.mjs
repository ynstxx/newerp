import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { close, connect, exec } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'

/**
 * 单据编号自动生成：PREFIX-YYYY-0001，按租户 × 前缀 × 年度递增。
 * 用户不该再被要求"想一个编号怎么写"。
 */
const password = 'test-pass-123'
const slug = `cg${Date.now().toString(36)}`
const email = `cg-${randomUUID().slice(0, 8)}@example.com`
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
  await createTenant({ requestId: 'test', userId: null }, { slug, name: '编号公司', email, password })
  app = await makeApp()
  cookie = await app.login(email, password)
})

test.after(async () => {
  if (app) await app.close()
})

const post = async (/** @type {string} */ p, /** @type {unknown} */ b) => {
  const res = await app.call('POST', `/t/${slug}${p}`, b, cookie)
  return { s: res.status, j: await jsonOf(res) }
}

test('客户/供应商：不填编号时自动生成，前缀按类型区分', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const year = String(new Date().getUTCFullYear())

  const c1 = await post('/api/parties', { name: '客户甲', partyType: 'customer' })
  const c2 = await post('/api/parties', { name: '客户乙', partyType: 'customer' })
  const s1 = await post('/api/parties', { name: '供应商甲', partyType: 'supplier' })

  assert.equal(c1.s, 201, JSON.stringify(c1.j))
  assert.match(c1.j.code, new RegExp(`^CUS-${year}-\\d{4}$`))
  assert.equal(c2.j.code, `CUS-${year}-0002`, '同前缀应按序递增，不是随机')
  assert.match(s1.j.code, new RegExp(`^SUP-${year}-0001$`), '供应商用另一条序列')

  // 显式给编号仍然优先（客户自己有一套编码体系时不挡）
  const manual = await post('/api/parties', { code: 'my-code', name: '客户丙', partyType: 'customer' })
  assert.equal(manual.j.code, 'MY-CODE')
})

test('商机/物料/采购单/工单：各走自己的前缀，互不干扰', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const year = String(new Date().getUTCFullYear())
  const party = (await post('/api/parties', { name: '客户丁', partyType: 'customer' })).j

  const opp = await post('/api/opportunities', { name: '自动编号商机', partyId: party.id, estAmount: '1.00' })
  assert.equal(opp.s, 201, JSON.stringify(opp.j))
  assert.match(opp.j.code, new RegExp(`^OPP-${year}-\\d{4}$`))

  const item = await post('/api/items', { name: '交换机', baseUom: '台' })
  assert.match(item.j.code, new RegExp(`^ITM-${year}-\\d{4}$`))

  const sup = (await post('/api/parties', { name: '供应商乙', partyType: 'supplier' })).j
  const po = await post('/api/purchase-orders', {
    partyId: sup.id,
    lines: [{ itemId: item.j.id, qty: '1', price: '100.00' }],
  })
  assert.equal(po.s, 201, JSON.stringify(po.j))
  assert.match(po.j.code, new RegExp(`^PO-${year}-\\d{4}$`))

  const tk = await post('/api/tickets', { title: '设备告警', priority: 'high', partyId: party.id })
  assert.match(tk.j.code, new RegExp(`^TK-${year}-\\d{4}$`))
})

test('并发下不发重号', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const [a, b, c] = await Promise.all([
    post('/api/parties', { name: '并发1', partyType: 'customer' }),
    post('/api/parties', { name: '并发2', partyType: 'customer' }),
    post('/api/parties', { name: '并发3', partyType: 'customer' }),
  ])
  const codes = [a.j?.code, b.j?.code, c.j?.code].filter(Boolean)
  assert.equal(codes.length, 3, JSON.stringify([a.j, b.j, c.j]))
  assert.equal(new Set(codes).size, 3, `编号重复了：${codes.join(', ')}`)
})
