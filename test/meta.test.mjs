import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { close, connect, exec } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { DICTS, LABEL_PREFIX } from '../svc/meta.mjs'
import { PARTY_TYPES } from '../svc/party.mjs'
import { PO_STATUSES, PAYMENT_METHODS } from '../svc/purchase.mjs'
import { PROJECT_STATUSES } from '../svc/project.mjs'

/**
 * 数据字典（只读枚举）的三条门禁：
 *   1. 接口返回 == 服务端常量（字典就是常量的投影，不能自己长出一份）
 *   2. 前端不许再硬编码枚举值（否则又变成"改一个枚举动三处"）
 *   3. 每个字典都声明了 i18n key 前缀（否则前端渲染不出标签）
 */
const password = 'test-pass-123'
const slug = `md${Date.now().toString(36)}`
const email = `md-${randomUUID().slice(0, 8)}@example.com`
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
  await createTenant({ requestId: 'test', userId: null }, { slug, name: '字典公司', email, password })
  app = await makeApp()
  cookie = await app.login(email, password)
})

test.after(async () => {
  if (app) await app.close()
})

test('接口返回 == 服务端常量（字典是投影，不是第二份真源）', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const res = await app.call('GET', `/t/${slug}/api/meta/dicts`, undefined, cookie)
  assert.equal(res.status, 200)
  const body = await jsonOf(res)

  assert.deepEqual(body.dicts.partyType, PARTY_TYPES)
  assert.deepEqual(body.dicts.poStatus, PO_STATUSES)
  assert.deepEqual(body.dicts.paymentMethod, PAYMENT_METHODS)
  assert.deepEqual(body.dicts.projectStatus, PROJECT_STATUSES)
  // 一个字典一条不落
  assert.deepEqual(Object.keys(body.dicts).sort(), Object.keys(DICTS).sort())
  assert.ok(Object.keys(body.dicts).length >= 20, '字典数量太少，多半是漏注册了')
})

test('未登录拿不到字典', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  assert.equal((await app.call('GET', `/t/${slug}/api/meta/dicts`)).status, 401)
})

test('每个字典都有 i18n key 前缀（否则前端渲染不出标签）', async () => {
  const missing = Object.keys(DICTS).filter((k) => !LABEL_PREFIX[k])
  // 允许少数没有标签的场景，但必须显式列出来，不能默默漏
  // 这几个目前没有下拉界面（SN 状态、审批动作、价格类型、需求/方案状态），
  // 需要渲染时补 labelPrefix 即可
  const allowNoLabel = new Set([
    'snStatus',
    'decideAction',
    'priceType',
    'requirementStatus',
    'designStatus',
  ])
  assert.deepEqual(
    missing.filter((k) => !allowNoLabel.has(k)),
    [],
    `这些字典缺 labelPrefix：${missing.join(', ')}`,
  )
})

test('前端不再硬编码枚举值（防回退）', async () => {
  const dir = new URL('../web/src/views/', import.meta.url)
  const files = (await readdir(dir)).filter((f) => f.endsWith('.vue'))
  /** @type {string[]} */
  const bad = []
  for (const f of files) {
    const code = await readFile(new URL(f, dir), 'utf8')
    // 模块级硬编码状态数组
    if (/const STATUSES = \['/.test(code)) bad.push(`${f}: const STATUSES = [...]`)
    if (/const TYPES = \['/.test(code)) bad.push(`${f}: const TYPES = [...]`)
    // 内联枚举数组（partyType / partyStatus 这种）
    for (const lit of ["['customer', 'supplier', 'both']", "['active', 'disabled']"]) {
      if (code.includes(lit)) bad.push(`${f}: 内联 ${lit}`)
    }
  }
  assert.deepEqual(bad, [], `这些地方应该改用 dict('xxx')：\n${bad.join('\n')}`)
})
