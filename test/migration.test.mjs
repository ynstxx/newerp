import test from 'node:test'
import assert from 'node:assert/strict'
import { rebind } from '../db/rebind.mjs'
import { prepare } from '../db/index.mjs'
import { canonical, createTable, diff, TYPES } from '../db/ddl.mjs'
import { splitStatements } from '../db/migrate.mjs'
import { tables } from '../schema/index.mjs'

test('rebind：$n → ? 并按出现顺序重排参数', () => {
  const r = rebind('SELECT * FROM t WHERE a = $2 AND b = $1', ['A', 'B'])
  assert.equal(r.sql, 'SELECT * FROM t WHERE a = ? AND b = ?')
  assert.deepEqual(r.args, ['B', 'A'])
})

test('$t：租户值追加在末尾，不动调用方的 $1', () => {
  const p = prepare({ tenantId: 'T1' }, 'SELECT id FROM party WHERE $t AND party_type = $1', ['customer'])
  assert.equal(p.sql, 'SELECT id FROM party WHERE tenant_id = $2 AND party_type = $1')
  assert.deepEqual(p.args, ['customer', 'T1'])
  // 换方言后参数顺序跟着占位符走
  assert.deepEqual(rebind(p.sql, p.args).args, ['T1', 'customer'])
})

test('$t：缺 tenantId 直接抛错，不静默放过', () => {
  assert.throws(() => prepare({ tenantId: null }, 'SELECT 1 WHERE $t'), /ctx\.tenantId/)
  assert.throws(() => prepare(undefined, 'SELECT 1 WHERE $t'), /ctx\.tenantId/)
})

test('splitStatements：跳过注释与字符串里的分号', () => {
  const sql = `-- 注释; 里的分号
CREATE TABLE a (x text);
CREATE TABLE b (y text NOT NULL);
-- 尾部注释
`
  const st = splitStatements(sql)
  assert.equal(st.length, 2)
  assert.match(st[0], /^CREATE TABLE a/)
  assert.match(st[1], /^CREATE TABLE b/)
})

test('canonical：复合主键、tenant_id 前缀、外键复合指向', () => {
  const c = canonical(tables)
  const party = c.party
  assert.deepEqual(party.pk, ['tenant_id', 'id'])
  assert.deepEqual(party.uniq, [['tenant_id', 'code']])
  assert.deepEqual(party.index, [
    ['tenant_id', 'name'],
    ['tenant_id', 'party_type', 'status'],
    ['tenant_id', 'created_at', 'id'],
  ])
  assert.deepEqual(c.party_contact.fk, [
    { cols: ['tenant_id', 'party_id'], ref: 'party', refCols: ['tenant_id', 'id'] },
  ])
  // 声明式主键：不自动补 id
  assert.deepEqual(c.org_membership.pk, ['tenant_id', 'user_id'])
  assert.ok(c.org_membership.cols.some((x) => x.n === 'tenant_id'))
  assert.ok(!c.org_membership.cols.some((x) => x.n === 'id'))
  // 全局表不加 tenant_id
  assert.deepEqual(c.auth_user.pk, ['id'])
  assert.ok(!c.auth_user.cols.some((x) => x.n === 'tenant_id'))
})

test('createTable：双库禁用清单零出现', () => {
  const c = canonical(tables)
  const forbidden = [/\bRETURNING\b/i, /LAST_INSERT_ID/i, /\bnow\(\)/i, /CURRENT_TIMESTAMP/i]
  for (const driver of /** @type {const} */ (['pg', 'mysql'])) {
    for (const t of Object.values(c)) {
      const sql = createTable(t, driver)
      for (const re of forbidden) assert.doesNotMatch(sql, re, `${t.name}@${driver} 命中禁用特性 ${re}`)
      // uuid 双库映射（有 uuid 列的表才检查）
      if (!t.cols.some((c) => c.t === 'uuid')) continue
      if (driver === 'mysql') assert.match(sql, /char\(36\)/)
      else assert.match(sql, /\buuid\b/)
    }
  }
})

test('diff：空快照 → 全是 CREATE TABLE；再 diff 一次 → 无语句', () => {
  const c = canonical(tables)
  const first = diff({}, c, 'pg')
  assert.equal(first.filter((s) => s.startsWith('CREATE TABLE')).length, Object.keys(c).length)
  assert.equal(diff(c, c, 'pg').length, 0)
  // 加列
  const next = structuredClone(c)
  next.party.cols.push({ n: 'website', t: 'code', notNull: false })
  const add = diff(c, next, 'mysql')
  assert.equal(add.length, 1)
  assert.match(add[0], /ALTER TABLE `party` ADD COLUMN `website` varchar\(64\)/)
})

test('类型映射表：两库都有物理类型，无遗漏', () => {
  for (const [token, m] of Object.entries(TYPES)) {
    assert.ok(m.pg, `${token} 缺 pg 映射`)
    assert.ok(m.mysql, `${token} 缺 mysql 映射`)
  }
})
