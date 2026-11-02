import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from '../config.mjs'
import { close, connect, exec, one } from '../db/index.mjs'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'

/**
 * 双库语义门禁：这些差异在"单库跑通"时完全看不见。
 */

test('时间戳落库必须是 UTC 墙钟（不是进程本地时区）', async (t) => {
  try {
    await connect()
  } catch (err) {
    return t.skip(`需要数据库（${/** @type {Error} */ (err).message}）`)
  }
  t.after(close)

  const tenantId = randomUUID()
  const id = randomUUID()
  const tenant = { tenantId }
  const at = new Date('2026-01-01T00:00:00.000Z')

  // 借 party 表做载体
  await exec(
    tenant,
    `INSERT INTO party (tenant_id, id, code, name, party_type, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, 'UTC', 'customer', 'active', 1, $4, $4)`,
    [tenantId, id, `U${Date.now().toString(36)}`, at],
  )
  t.after(() => exec(tenant, 'DELETE FROM party WHERE $t AND id = $1', [id]).catch(() => {}))

  // 关键：读库里的**裸值**，不走驱动的时间解析。
  // mysql2 默认 timezone='local' 时会把 Date 按进程时区格式化成 08:00（本机 +0800），
  // 而往返读写是自洽的，所以普通 round-trip 断言发现不了这个 bug。
  const sql =
    config.db.driver === 'mysql'
      ? `SELECT CAST(created_at AS CHAR) AS raw FROM party WHERE $t AND id = $1`
      : `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS') AS raw FROM party WHERE $t AND id = $1`
  const row = await one(tenant, sql, [id])
  assert.equal(/** @type {any} */ (row).raw, '2026-01-01 00:00:00.000')
})

test('业务编码大小写不敏感：ABC 与 abc 视为同一个', async (t) => {
  try {
    await connect()
  } catch (err) {
    return t.skip(`需要数据库（${/** @type {Error} */ (err).message}）`)
  }
  const password = 'test-pass-123'
  const slug = `uc${Date.now().toString(36)}`
  const email = `uc-${randomUUID().slice(0, 8)}@example.com`
  await exec({}, 'DELETE FROM login_attempt', [])
  await createTenant({ requestId: 'test', userId: null }, { slug, name: '大小写', email, password })
  const app = await makeApp()
  t.after(() => app.close())
  const cookie = await app.login(email, password)

  const first = await app.call(
    'POST',
    `/t/${slug}/api/parties`,
    { code: 'ab-1', name: '小写', partyType: 'customer' },
    cookie,
  )
  assert.equal(first.status, 201)
  // 落库应当是大写规范形式
  assert.equal((await jsonOf(first)).code, 'AB-1')

  const dup = await app.call(
    'POST',
    `/t/${slug}/api/parties`,
    { code: 'ab-1', name: '再来一个小写', partyType: 'customer' },
    cookie,
  )
  assert.equal(dup.status, 409, '同一编码只差大小写也必须 409（否则 PG 会允许两条并存）')
})
