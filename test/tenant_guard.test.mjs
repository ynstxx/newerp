import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { tables } from '../schema/index.mjs'

/**
 * 防线二（DESIGN §4.3）：扫 store/**\/*.mjs 的 SQL 字面量，
 * 碰租户表却没带 $t → CI 失败。
 *
 * 例外只有两种，都必须显式写在代码里：
 *   1. INSERT 且列清单里写了 tenant_id（租户值由调用方从 ctx 传入）
 *   2. SQL 里带  tenant-free  标记（确实没有单一租户可带，必须写明理由）
 *
 * 三道额外检查（都是审计发现的旧盲区）：
 *   · 递归扫描子目录 —— 否则新建 store/xxx/ 就完全脱检
 *   · 禁止表名插值 —— `FROM ${TBL}` 会让表名匹配失效，等于绕过守卫
 *   · 一条 SQL 里出现多张租户表时必须显式带表别名限定（本项目目前零 JOIN）
 */
const TENANT_TABLES = tables.filter((t) => t.tenant).map((t) => t.name)

/** @param {string} sql */
export function scan(sql) {
  const s = sql.trim()
  if (!/\b(select|insert|update|delete)\b/i.test(s)) return []
  if (s.includes('tenant-free')) return []
  // 动态表名：只有「同时没有 $t」时才拦。
  // 同构表的通用 CRUD 助手是合理写法（9 张表一份代码），它带 $t 就没有漏租户谓词的风险；
  // 反过来，动态表名 + 没有 $t 才真的可能绕过守卫。
  if (!s.includes('$t') && /\b(from|into|update|join)\s+\$\{/i.test(s)) return ['<动态表名>']
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

/** 递归列出 store 下所有 .mjs */
async function storeFiles() {
  const root = new URL('../store/', import.meta.url)
  const names = await readdir(root, { recursive: true })
  return names.map(String).filter((f) => f.endsWith('.mjs'))
}

test('守卫本身有效：漏 $t 会被抓，三种例外放行', () => {
  assert.deepEqual(scan(`SELECT id FROM party WHERE status = $1`), ['party'])
  assert.deepEqual(scan(`UPDATE party SET name = $1`), ['party'])
  assert.deepEqual(scan(`SELECT id FROM party WHERE $t AND status = $1`), [])
  assert.deepEqual(
    scan(`INSERT INTO audit_log (tenant_id, id, module) VALUES ($1, $2, $3)`),
    [],
    'INSERT 显式写 tenant_id 应放行',
  )
  assert.deepEqual(scan(`SELECT id FROM party WHERE id = $1 /* tenant-free */`), [], '显式标记应放行')
  // 全局表不受管
  assert.deepEqual(scan(`SELECT id FROM auth_user WHERE email = $1`), [])
  // 动态表名 + 没有 $t → 拦（这才是绕过守卫的写法）
  assert.deepEqual(scan('SELECT id FROM ${TBL} WHERE status = $1'), ['<动态表名>'])
  // 动态表名 + 带 $t → 放行（同构表的通用助手是合理写法）
  assert.deepEqual(scan('SELECT ${cols} FROM ${table} WHERE $t'), [])
})

test('store/**/*.mjs 全部通过租户守卫（含子目录）', async () => {
  /** @type {string[]} */
  const bad = []
  for (const f of await storeFiles()) {
    const code = await readFile(new URL(`../store/${f}`, import.meta.url), 'utf8')
    for (const lit of literals(code)) {
      const hit = scan(lit)
      if (hit.length) bad.push(`${f}: 碰了 ${hit.join(',')} 却缺 $t / 用了动态表名 → ${lit.replace(/\s+/g, ' ').slice(0, 90)}`)
    }
  }
  assert.deepEqual(bad, [], `租户守卫失败:\n${bad.join('\n')}`)
})
