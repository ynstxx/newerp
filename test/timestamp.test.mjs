import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { close, connect, exec, one } from '../db/index.mjs'

/**
 * 回归门禁：时间戳必须能「读出来再写回去」。
 * M1 之前所有写操作都传 new Date()，没人踩到；一旦某列写回读到的值，
 * 如果数据层把它转成 ISO 字符串，MySQL 的 datetime(3) 会直接拒绝。
 */
test('时间戳读-改-写：两库都不能踩格式差异', async (t) => {
  try {
    await connect()
  } catch (err) {
    return t.skip(`需要数据库（${/** @type {Error} */ (err).message}）`)
  }
  // 先删数据再关池：两个 after 分开写时顺序不保证，关池后再 exec 会重开一个没人关的池，进程就不退出
  t.after(async () => {
    await exec(tenant, 'DELETE FROM party WHERE $t AND id = $1', [id]).catch(() => {})
    await close()
  })

  const tenantId = randomUUID()
  const id = randomUUID()
  const tenant = { tenantId }

  // 借 party 表做载体：它有两列 time
  await exec(
    tenant,
    `INSERT INTO party (tenant_id, id, code, name, party_type, status, version, created_at, updated_at)
     VALUES ($1, $2, $3, 'T', 'customer', 'active', 1, $4, $4)`,
    [tenantId, id, `T${Date.now().toString(36)}`, new Date()],
  )

  const before = await one(tenant, 'SELECT created_at, updated_at FROM party WHERE $t AND id = $1', [id])
  assert.ok(before, '应该读得到刚插入的行')

  // 读出来的值原样写回去 —— 这一步在数据层转成 ISO 字符串时，MySQL 会报
  // ER_TRUNCATED_WRONG_VALUE / "Incorrect datetime value"
  await exec(tenant, 'UPDATE party SET updated_at = $1 WHERE $t AND id = $2', [before.created_at, id])

  const after = await one(tenant, 'SELECT updated_at FROM party WHERE $t AND id = $1', [id])
  assert.equal(
    new Date(/** @type {any} */ (after).updated_at).toISOString(),
    new Date(/** @type {any} */ (before).created_at).toISOString(),
    '写回去的时间应与读出来的一致',
  )
})
