import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { close, connect, exec } from '../db/index.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { makeApp, jsonOf } from './helpers.mjs'

const password = 'test-pass-123'
const ownerA = `ia-${randomUUID().slice(0, 8)}@example.com`
const ownerB = `ib-${randomUUID().slice(0, 8)}@example.com`
const slugA = `ia${Date.now().toString(36)}`
const slugB = `ib${Date.now().toString(36)}`

/** @type {any} */
let app
let dbUp = false
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }
  await exec({}, 'DELETE FROM login_attempt', [])
  await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲集成', email: ownerA, password })
  await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙集成', email: ownerB, password })
  app = await makeApp()
  cookieA = await app.login(ownerA, password)
  cookieB = await app.login(ownerB, password)
})

test.after(async () => {
  await app?.close()
  await close()
})

/** @param {string} path @param {string} slug @param {string} cookie */
const get = (path, slug, cookie = cookieA) => app.call('GET', `/t/${slug}${path}`, undefined, cookie)
/** @param {string} path @param {unknown} body @param {string} slug @param {string} cookie */
const post = (path, body, slug, cookie = cookieA) => app.call('POST', `/t/${slug}${path}`, body, cookie)
/** @param {string} path @param {unknown} body @param {string} slug @param {string} cookie */
const patch = (path, body, slug, cookie = cookieA) => app.call('PATCH', `/t/${slug}${path}`, body, cookie)

let seq = 0
/** @param {string} code */
const itemOf = (code) => ({
  code,
  name: `物料 ${code}`,
  spec: '48 口',
  category: 'SWITCH',
  baseUom: 'PCS',
})

/** @param {string} cookie @param {string} slug @param {string} code */
async function newItem(cookie = cookieA, slug = slugA, code = `I${++seq}`) {
  const res = await post('/api/items', itemOf(code), slug, cookie)
  const body = await jsonOf(res)
  assert.equal(res.status, 201, JSON.stringify(body))
  return body
}

/** @param {string} cookie @param {string} slug @param {string} code */
async function newWarehouse(cookie = cookieA, slug = slugA, code = `W${++seq}`) {
  const res = await post('/api/warehouses', { code, name: `仓库 ${code}` }, slug, cookie)
  const body = await jsonOf(res)
  assert.equal(res.status, 201, JSON.stringify(body))
  return body
}

/**
 * @param {{ warehouseId: string, itemId: string, qty: unknown, dir: 'in'|'out', moveType?: string, sns?: string[], refType?: string, refId?: string, unitCost?: unknown }} m
 * @param {string} cookie @param {string} slug
 */
const move = (m, cookie = cookieA, slug = slugA) =>
  post('/api/stock/moves', { moveType: 'manual', ...m }, slug, cookie)

/** @param {string} warehouseId @param {string} itemId @param {string} slug @param {string} cookie */
async function balanceOf(warehouseId, itemId, slug = slugA, cookie = cookieA) {
  const body = await jsonOf(
    await get(`/api/stock/balances?warehouseId=${warehouseId}&itemId=${itemId}`, slug, cookie),
  )
  return body.items.reduce((/** @type {number} */ n, /** @type {any} */ b) => n + b.qty, 0)
}

test('物料 CRUD：编码重复 409、旧 version 409、审计落库', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const created = await newItem(cookieA, slugA, 'IT-001')
  assert.equal(created.code, 'IT-001')
  assert.equal(created.status, 'active')
  assert.equal(created.version, 1)

  const dup = await post('/api/items', itemOf('IT-001'), slugA)
  assert.equal(dup.status, 409)

  const got = await get(`/api/items/${created.id}`, slugA)
  assert.equal(got.status, 200)
  assert.equal((await jsonOf(got)).name, '物料 IT-001')

  const okay = await patch(`/api/items/${created.id}`, { name: '改名物料', version: 1 }, slugA)
  assert.equal(okay.status, 200)
  const patched = await jsonOf(okay)
  assert.equal(patched.name, '改名物料')
  assert.equal(patched.version, 2)

  const stale = await patch(`/api/items/${created.id}`, { name: '再改', version: 1 }, slugA)
  assert.equal(stale.status, 409)
  assert.match((await jsonOf(stale)).error.details.reason, /版本已变/)

  // 仓库同样有编码唯一与乐观锁
  const wh = await newWarehouse(cookieA, slugA, 'WH-001')
  assert.equal((await post('/api/warehouses', { code: 'WH-001', name: '重复仓' }, slugA)).status, 409)
  assert.equal((await patch(`/api/warehouses/${wh.id}`, { name: '主仓', version: 1 }, slugA)).status, 200)
  assert.equal((await patch(`/api/warehouses/${wh.id}`, { name: '旧改', version: 1 }, slugA)).status, 409)
})

test('入库 → 余额；出库 → 余额减少；流水两条且数量为 numeric', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const item = await newItem()
  const wh = await newWarehouse()

  const inbound = await move({ warehouseId: wh.id, itemId: item.id, qty: '10.25', dir: 'in', unitCost: '12.34' })
  const inBody = await jsonOf(inbound)
  assert.equal(inbound.status, 201, JSON.stringify(inBody))
  assert.equal(inBody.move.qty, 10.25)
  assert.equal(inBody.move.unitCost, 12.34)
  assert.equal(inBody.balance, 10.25)

  assert.equal(await balanceOf(wh.id, item.id), 10.25)

  const outbound = await move({ warehouseId: wh.id, itemId: item.id, qty: '4.5', dir: 'out' })
  assert.equal(outbound.status, 201)
  assert.equal((await jsonOf(outbound)).balance, 5.75)
  assert.equal(await balanceOf(wh.id, item.id), 5.75)

  const moves = await jsonOf(await get(`/api/stock/moves?itemId=${item.id}`, slugA))
  assert.equal(moves.items.length, 2)
  assert.deepEqual(
    moves.items.map((/** @type {any} */ m) => m.dir),
    ['out', 'in'],
  )
})

test('出库超量 → 409、available 正确、余额不被扣成负数', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const item = await newItem()
  const wh = await newWarehouse()
  assert.equal((await move({ warehouseId: wh.id, itemId: item.id, qty: 3, dir: 'in' })).status, 201)

  const over = await move({ warehouseId: wh.id, itemId: item.id, qty: 5, dir: 'out' })
  assert.equal(over.status, 409)
  const body = await jsonOf(over)
  assert.equal(body.error.details.reason, '库存不足')
  assert.equal(body.error.details.available, 3)
  assert.equal(await balanceOf(wh.id, item.id), 3, '失败的出库不能改变余额')

  const moves = await jsonOf(await get(`/api/stock/moves?itemId=${item.id}`, slugA))
  assert.equal(moves.items.length, 1, '失败的出库不能留下流水')
})

test('SN 登记 + snTrace 反查全部流水', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const item = await newItem()
  const wh = await newWarehouse()
  const sn = `SN_${randomUUID().slice(0, 8).toUpperCase()}`
  const lookalike = sn.replace('_', 'X')

  const inbound = await move({
    warehouseId: wh.id,
    itemId: item.id,
    qty: 1,
    dir: 'in',
    moveType: 'purchase_in',
    refType: 'purchase_order',
    refId: randomUUID(),
    sns: [sn],
  })
  assert.equal(inbound.status, 201)

  // 同物料再入一个「长得像」的 SN：sn_list 的 LIKE 必须转义下划线
  assert.equal((await move({ warehouseId: wh.id, itemId: item.id, qty: 1, dir: 'in', sns: [lookalike] })).status, 201)

  const afterIn = await jsonOf(await get(`/api/stock/sn/${sn}`, slugA))
  assert.equal(afterIn.sn.status, 'in_stock')
  assert.equal(afterIn.movements.length, 1, `_ 不能被当成 LIKE 通配符（串到 ${lookalike}）`)

  const outbound = await move({
    warehouseId: wh.id,
    itemId: item.id,
    qty: 1,
    dir: 'out',
    moveType: 'material_issue',
    refType: 'material_issue',
    refId: randomUUID(),
    sns: [sn],
  })
  assert.equal(outbound.status, 201)

  const trace = await jsonOf(await get(`/api/stock/sn/${sn}`, slugA))
  assert.equal(trace.sn.status, 'issued')
  assert.equal(trace.movements.length, 2, 'SN 的入库与出库都要能反查到')
  assert.deepEqual(
    trace.movements.map((/** @type {any} */ m) => m.dir),
    ['in', 'out'],
  )
  assert.deepEqual(trace.movements[0].sns, [sn])

  // 同一 SN 不能重复出库，也不能重复登记
  const again = await move({ warehouseId: wh.id, itemId: item.id, qty: 1, dir: 'out', sns: [sn] })
  assert.equal(again.status, 409)
  const dupIn = await move({ warehouseId: wh.id, itemId: item.id, qty: 1, dir: 'in', sns: [sn] })
  assert.equal(dupIn.status, 409)
  assert.equal(await balanceOf(wh.id, item.id), 1, '只剩 lookalike 那 1 件')
})

test('stock_bin 连续/并发入库同一 (仓库,物料)：只有一行且数量累加', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const item = await newItem()
  const wh = await newWarehouse()

  // 连续两次：第一次 UPDATE 0 行 → INSERT，第二次 UPDATE 命中
  assert.equal((await move({ warehouseId: wh.id, itemId: item.id, qty: 2, dir: 'in' })).status, 201)
  assert.equal((await move({ warehouseId: wh.id, itemId: item.id, qty: 3, dir: 'in' })).status, 201)
  assert.equal(await balanceOf(wh.id, item.id), 5)

  const bins = await jsonOf(await get(`/api/stock/balances?warehouseId=${wh.id}&itemId=${item.id}`, slugA))
  assert.equal(bins.items.length, 1, 'uniq(warehouse_id,item_id) 只能有一行余额')
  assert.equal(bins.items[0].qty, 5)

  // 再并发两次：item 行锁把同一物料的记账串行化，绝不撞唯一键
  const item2 = await newItem()
  const results = await Promise.all([
    move({ warehouseId: wh.id, itemId: item2.id, qty: 1, dir: 'in' }),
    move({ warehouseId: wh.id, itemId: item2.id, qty: 2, dir: 'in' }),
  ])
  assert.deepEqual(
    results.map((/** @type {any} */ r) => r.status),
    [201, 201],
  )
  assert.equal(await balanceOf(wh.id, item2.id), 3)
  const bins2 = await jsonOf(await get(`/api/stock/balances?warehouseId=${wh.id}&itemId=${item2.id}`, slugA))
  assert.equal(bins2.items.length, 1)
})

test('跨租户一律 404；未知字段 400；price_book 用 money.mjs 解析', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const item = await newItem()
  const wh = await newWarehouse()
  assert.equal((await move({ warehouseId: wh.id, itemId: item.id, qty: 1, dir: 'in' })).status, 201)

  assert.equal((await get(`/api/items/${item.id}`, slugB, cookieB)).status, 404)
  assert.equal((await patch(`/api/items/${item.id}`, { name: '偷改' }, slugB, cookieB)).status, 404)
  assert.equal((await get(`/api/warehouses/${wh.id}`, slugB, cookieB)).status, 404)
  assert.equal((await get('/api/stock/moves', slugB, cookieB)).status, 200)
  const listB = await jsonOf(await get('/api/stock/moves', slugB, cookieB))
  assert.ok(!listB.items.some((/** @type {any} */ m) => m.itemId === item.id))

  // 用 B 的凭证拿 A 的仓库记账 → 404，且不写任何东西
  assert.equal(
    (await move({ warehouseId: wh.id, itemId: item.id, qty: 1, dir: 'in' }, cookieB, slugB)).status,
    404,
  )

  const extra = await post('/api/items', { ...itemOf('IT-X'), tenantId: 'x' }, slugA)
  assert.equal(extra.status, 400)
  assert.match((await jsonOf(extra)).error.details.reason, /未知字段/)

  const badQty = await move({ warehouseId: wh.id, itemId: item.id, qty: 'abc', dir: 'in' })
  assert.equal(badQty.status, 400)
  assert.equal((await jsonOf(badQty)).error.details.fields.qty, 'money')

  const price = await post(
    '/api/price-books',
    { itemId: item.id, priceType: 'sale', price: '1234.56', validFrom: '2026-01-01' },
    slugA,
  )
  const p = await jsonOf(price)
  assert.equal(price.status, 201, JSON.stringify(p))
  assert.equal(p.price, 1234.56)
  assert.equal(p.version, 1)

  const badPrice = await post(
    '/api/price-books',
    { itemId: item.id, priceType: 'sale', price: '12.3.4' },
    slugA,
  )
  assert.equal(badPrice.status, 400)
  assert.equal((await jsonOf(badPrice)).error.details.fields.price, 'money')

  const stale = await patch(`/api/price-books/${p.id}`, { price: '1.00', version: 99 }, slugA)
  assert.equal(stale.status, 409)

  assert.equal((await get(`/api/stock/sn/NOPE-${randomUUID()}`, slugB, cookieB)).status, 404)
  assert.equal((await get('/api/items/not-a-uuid', slugA)).status, 404)
})

test('删除引用检查：被库存/流水引用的物料与仓库 → 409（不是 500）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const item = (await newItem(cookieA, slugA, `DEL${++seq}`)).id
  const wh = (await newWarehouse(cookieA, slugA, `DELW${++seq}`)).id
  const inb = await post(
    '/api/stock/moves',
    { warehouseId: wh, itemId: item, qty: '5', dir: 'in', moveType: 'init', unitCost: '10.00' },
    slugA,
    cookieA,
  )
  assert.equal(inb.status, 201, JSON.stringify(await jsonOf(inb)))

  // 有引用 → 409（不是外键错误冒成的 500），原因可读
  const delItem = await app.call('DELETE', `/t/${slugA}/api/items/${item}`, undefined, cookieA)
  const delItemBody = await jsonOf(delItem)
  assert.equal(delItem.status, 409, JSON.stringify(delItemBody))
  assert.match(String(delItemBody.error.details.reason ?? ''), /引用/)

  const delWh = await app.call('DELETE', `/t/${slugA}/api/warehouses/${wh}`, undefined, cookieA)
  const delWhBody = await jsonOf(delWh)
  assert.equal(delWh.status, 409, JSON.stringify(delWhBody))
  assert.match(String(delWhBody.error.details.reason ?? ''), /引用/)

  // 没被引用时可以删
  const fresh = (await newItem(cookieA, slugA, `DEL2${++seq}`)).id
  assert.equal((await app.call('DELETE', `/t/${slugA}/api/items/${fresh}`, undefined, cookieA)).status, 200)
})
