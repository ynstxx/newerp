import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { tables } from '../schema/index.mjs'

/**
 * 防线二（DESIGN §4.3）：扫 store/**\/*.mjs 的 SQL 字面量，
 * 碰租户表却没带 $t → CI 失败。
 * 例外只有两种，都必须显式写在代码里：
 *   1. INSERT 且列清单里写了 tenant_id（租户值由调用方从 ctx 传入）
 *   2. SQL 里带 /* tenant-free *\/ 标记（确实没有单一租户可带，必须写明理由）
 */
const TENANT_TABLES = tables.filter((t) => t.tenant).map((t) => t.name)

/** @param {string} sql */
export function scan(sql) {
  const s = sql.trim()
  if (!/\b(select|insert|update|delete)\b/i.test(s)) return []
  if (s.includes('/* tenant-free */')) return []
  const touched = TENANT_TABLES.filter((t) => new RegExp(`\\b${t}\\b`).test(s))
  if (!touched.length) return []
  if (/^insert\s+into\s+[`"]?\w+[`"]?\s*\([^)]*\btenant_id\b/i.test(s)) return []
  if (s.includes('$t')) return []
  return touched
}

/** 取出文件里的模板串与普通字符串字面量 */
function literals(/** @type {string} */ code) {
  return [...code.matchAll(/`([\s\S]*?)`|'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1] ?? m[2] ?? '')
}

const FILES = async () => {
  const out = []
  for (const f of await readdir(new URL('../store/', import.meta.url))) {
    if (f.endsWith('.mjs')) out.push(f)
  }
  return out
}

test('守卫本身有效：漏 $t 会被抓，两种例外放行', () => {
  assert.deepEqual(scan(`SELECT id FROM party WHERE status = $1`), ['party'])
  assert.deepEqual(scan(`UPDATE party SET name = $1`), ['party'])
  assert.deepEqual(scan(`SELECT id FROM party WHERE $t AND status = $1`), [])
  assert.deepEqual(
    scan(`INSERT INTO audit_log (tenant_id, id, module) VALUES ($1, $2, $3)`),
    [],
    'INSERT 显式写 tenant_id 应放行',
  )
  assert.deepEqual(
    scan(`SELECT /* tenant-free */ id FROM party WHERE id = $1`),
    [],
    '显式 tenant-free 标记应放行',
  )
  // 全局表不受管
  assert.deepEqual(scan(`SELECT id FROM auth_user WHERE email = $1`), [])
})

test('store/**/*.mjs 全部通过租户守卫', async () => {
  /** @type {string[]} */
  const bad = []
  for (const f of await FILES()) {
    const code = await readFile(new URL(`../store/${f}`, import.meta.url), 'utf8')
    for (const lit of literals(code)) {
      const hit = scan(lit)
      if (hit.length) bad.push(`${f}: 碰了 ${hit.join(',')} 却缺 $t → ${lit.replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  assert.deepEqual(bad, [], `租户守卫失败:\n${bad.join('\n')}`)
})
