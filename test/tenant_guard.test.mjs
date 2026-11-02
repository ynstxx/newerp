import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { tables } from '../schema/index.mjs'

// 防线二（DESIGN §4.3）：扫 store/**/*.mjs 的 SQL 字面量，
// 碰租户表却没带 $t → CI 失败。
//
// 例外只有两种，都必须显式写在代码里：
//   1. INSERT 且列清单里写了 tenant_id。但列清单只是一句声明，看不出值从哪来，
//      所以文件级扫描还要求「字面量之后 400 字符内出现 tenantId」。
//   2. SQL 里带 tenant-free 标记，且标记必须带**非空理由**：
//      `/* tenant-free: <理由> *\/`（理由 ≥2 个非空白字符）。
//      存量代码把理由写在 SQL 上一行的注释里（store/tenant.mjs、store/notify.mjs），
//      文件级扫描认这种写法；但「空标记」永远不会放行。
//
// 六道额外检查（都是审计发现的旧盲区）：
//   · 递归扫描子目录 —— 否则新建 store/xxx/ 就完全脱检
//   · 禁止表名插值 —— `FROM ${TBL}` 会让表名匹配失效，等于绕过守卫
//   · 一条 SQL 里出现多张租户表时必须显式带表别名限定（本项目目前零 JOIN）
//   · tenant-free 空理由 → FAIL（第 4 波审计盲区 1）
//   · INSERT 的 tenant_id 必须看得出值来源（盲区 2）
//   · 全局表 auth_user 的 UPDATE/INSERT 必须有证据（盲区 3）

const TENANT_TABLES = tables.filter((t) => t.tenant).map((t) => t.name)

/** 全局表：没有 tenant_id，写它等于跨租户 —— 单独走 GLOBAL_WRITE 检查 */
const GLOBAL_WRITE_TABLES = ['auth_user']

export const DYNAMIC_TABLE = '<动态表名>'
export const EMPTY_REASON = '<tenant-free 缺理由>'
export const UNTRACED_TENANT = '<tenant_id 值来源不明>'
export const GLOBAL_WRITE = 'GLOBAL_WRITE'

/** INSERT 字面量之后多久之内必须看见 tenantId（宁可误报，也别漏） */
const ARG_WINDOW = 400
/** 文件级找「上一行注释里的理由」的窗口 */
const COMMENT_WINDOW = 600

/**
 * GLOBAL_WRITE 白名单：key = `store/<文件>:<函数名>`。
 * 只放行「写入意图本身就是平台级/跨租户」的函数，每条都必须写理由。
 * 白名单是**函数级**的：函数内部仍然应该尽量自己做成员校验（见报告里的风险）。
 * @type {Record<string, string>}
 */
export const GLOBAL_WRITE_ALLOW = {
  // 注册 / 建租户：用户行先于 membership 存在，此刻根本没有本租户可校验
  'store/user.mjs:insert': '注册/建租户时创建全局用户行，membership 在同一个事务里紧接着创建',
  // 平台管理员 CLI（cmd/user.mjs approve/disable），跨租户的平台级状态流转
  'store/user.mjs:setStatus': '平台管理员 CLI 按 email 放行/停用账号，是平台级动作',
  // 调用方 svc/integration_sync.mjs 已用 membershipByUser 断言「已是我方成员」才走到这里
  'store/integration.mjs:updateUserName': '仅由 integration_sync 调用，调用前已断言目标用户是本租户成员',
  // 同上；另外按邮箱全局唯一预检，避免把两个外部人并成一个
  'store/integration.mjs:updateUserEmail': '仅由 integration_sync 调用，调用前已断言成员且做了邮箱唯一性预检',
}

/**
 * tenant-free 标记状态。
 *   none  —— 没这个标记
 *   ok    —— 标记带非空理由（`tenant-free: 理由`，半角/全角冒号都认）
 *   empty —— 有标记但理由为空（`/* tenant-free *\/`）→ 一律 FAIL
 * @param {string} text
 * @returns {'none' | 'ok' | 'empty'}
 */
function tenantFreeState(text) {
  let seen = false
  let empty = false
  for (const m of text.matchAll(/tenant-free\b/g)) {
    seen = true
    if (!reasonAfter(text, (m.index ?? 0) + m[0].length, true)) empty = true
  }
  if (!seen) return 'none'
  return empty ? 'empty' : 'ok'
}

/**
 * 关键字之后的理由文本：只看同一行、注释结束符之前的文字。
 * @param {string} text
 * @param {number} from 「tenant-free」关键字结束位置
 * @param {boolean} requireColon SQL 内联标记必须带冒号；源文件注释里允许 `tenant-free 是因为…`
 * @returns {boolean} 理由是否非空（≥2 个非空白字符）
 */
function reasonAfter(text, from, requireColon) {
  const body = text.slice(from).split('\n')[0].split('*/')[0]
  const m = /^([^\S\n]*[:：])?([\s\S]*)$/.exec(body)
  if (!m) return false
  if (requireColon && !m[1]) return false
  return (m[2] ?? '').replace(/\s/g, '').length >= 2
}

/**
 * 存量写法：理由写在 SQL 上一行的注释里。
 * 只在 SQL 字面量里已经有 tenant-free 标记时才看上下文 —— 否则一条无关注释
 * 就能把别的语句豁免掉。
 * @param {string} code
 * @param {number} litStart 字面量在源码里的起始位置
 * @returns {boolean}
 */
function reasonInContext(code, litStart) {
  const before = code.slice(Math.max(0, litStart - COMMENT_WINDOW), litStart)
  for (const m of before.matchAll(/tenant-free\b/g)) {
    if (reasonAfter(before, (m.index ?? 0) + m[0].length, false)) return true
  }
  return false
}

/**
 * 只做 SQL 级别的判断（导出给用例直接断言，方便写反例）。
 * @param {string} sql
 * @returns {string[]} 命中的问题；空数组 = 通过
 */
export function scan(sql) {
  const s = sql.trim()
  if (!/\b(select|insert|update|delete)\b/i.test(s)) return []
  const tf = tenantFreeState(s)
  if (tf === 'empty') return [EMPTY_REASON]
  if (tf === 'ok') return []
  // 动态表名：只有「同时没有 $t」时才拦。
  // 同构表的通用 CRUD 助手是合理写法（9 张表一份代码），它带 $t 就没有漏租户谓词的风险；
  // 反过来，动态表名 + 没有 $t 才真的可能绕过守卫。
  if (!s.includes('$t') && /\b(from|into|update|join)\s+\$\{/i.test(s)) return [DYNAMIC_TABLE]
  const touched = TENANT_TABLES.filter((t) => new RegExp(`\\b${t}\\b`).test(s))
  if (!touched.length) return []
  if (isTenantInsert(s)) return []
  if (s.includes('$t')) return []
  return touched
}

/**
 * INSERT 的列清单里写了 tenant_id —— 旧的 INSERT 例外。
 * 列清单本身不代表值来源，文件级还要查实参窗口。
 * @param {string} sql
 * @returns {boolean}
 */
function isTenantInsert(sql) {
  return /^insert\s+into\s+[`"]?\w+[`"]?\s*\([^)]*\btenant_id\b/i.test(sql.trim())
}

/**
 * SQL 的第一条 DML 是否在写全局表（UPDATE / INSERT）。
 * @param {string} sql
 * @returns {string | null} 命中的全局表名
 */
function globalWrite(sql) {
  const m = /^(insert\s+into|update)\s+[`"]?(\w+)/i.exec(sql.trim())
  const t = (m?.[2] ?? '').toLowerCase()
  return GLOBAL_WRITE_TABLES.includes(t) ? t : null
}

/**
 * 取出文件里的模板串与普通字符串字面量（带位置：文件级检查要看前后文）
 * @param {string} code
 * @returns {{ lit: string, start: number, end: number }[]}
 */
function literals(code) {
  return [...code.matchAll(/`([\s\S]*?)`|'((?:[^'\\]|\\.)*)'/g)].map((m) => ({
    lit: m[1] ?? m[2] ?? '',
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }))
}

/**
 * 字面量所在的函数（`export const foo =` / `function foo(` / `const foo =`）。
 * 粗糙但够用：守卫只想知道「同一函数体内有没有成员校验」。
 * @param {string} code
 * @param {number} at 字面量位置
 * @returns {{ name: string, start: number, end: number }}
 */
function enclosingFunction(code, at) {
  const re = /(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=)/g
  /** @type {{ name: string, start: number }[]} */
  const fns = []
  for (const m of code.matchAll(re)) fns.push({ name: m[1] ?? m[2] ?? '<anonymous>', start: m.index ?? 0 })
  let found = { name: '<top-level>', start: 0 }
  for (const fn of fns) {
    if (fn.start > at) break
    found = fn
  }
  const next = fns[fns.indexOf(found) + 1]
  return { name: found.name, start: found.start, end: next ? next.start : code.length }
}

/**
 * SQL 压成一行，报错信息里好读。
 * @param {string} s
 * @returns {string}
 */
const oneline = (s) => s.replace(/\s+/g, ' ').slice(0, 90)

/**
 * 文件级扫描：SQL 守卫 + INSERT 值来源 + 全局表写入。
 * @param {string} file store/ 下的相对路径
 * @param {string} code 源文件内容
 * @returns {string[]} 问题列表
 */
export function scanFile(file, code) {
  /** @type {string[]} */
  const bad = []
  for (const { lit, start, end } of literals(code)) {
    const sql = lit.trim()
    const tf = tenantFreeState(sql)
    // 标记带理由 → 放行；标记空但上一行注释写了理由 → 也放行（存量写法）
    const marked = tf === 'ok' || (tf === 'empty' && reasonInContext(code, start))
    const issues = marked ? [] : scan(sql)
    for (const i of issues) {
      const hint = i === EMPTY_REASON ? '（空理由不算豁免，写成 tenant-free: <理由>）' : ''
      bad.push(`租户守卫 store/${file}: [${i}]${hint} → ${oneline(sql)}`)
    }
    // INSERT 例外只看列清单会漏掉值来源：实参窗口里必须出现 tenantId
    if (!issues.length && isTenantInsert(sql)) {
      if (!/\btenantId\b/.test(code.slice(end, end + ARG_WINDOW))) {
        bad.push(
          `租户守卫 store/${file}: [${UNTRACED_TENANT}] 列清单有 tenant_id，但实参 400 字符内没有 tenantId → ${oneline(sql)}`,
        )
      }
    }
    // 全局表写入：没有 tenant_id 可带，必须另给证据
    const g = globalWrite(sql)
    if (g && !marked) {
      const fn = enclosingFunction(code, start)
      const body = code.slice(fn.start, fn.end)
      const guarded = /\b(?:memberExists|isMember)\s*\(/.test(body)
      const key = `store/${file}:${fn.name}`
      if (!guarded && !Object.hasOwn(GLOBAL_WRITE_ALLOW, key)) {
        bad.push(
          `全局表写入 store/${file}: [${GLOBAL_WRITE} ${g}] ${fn.name}() 既没 memberExists/isMember，也没 tenant-free: 理由，也不在白名单 → ${oneline(sql)}`,
        )
      }
    }
  }
  return bad
}

/** 递归列出 store 下所有 .mjs */
async function storeFiles() {
  const root = new URL('../store/', import.meta.url)
  const names = await readdir(root, { recursive: true })
  return names.map(String).filter((f) => f.endsWith('.mjs'))
}

test('守卫本身有效：漏 $t 会被抓，例外都要写清楚', () => {
  assert.deepEqual(scan(`SELECT id FROM party WHERE status = $1`), ['party'])
  assert.deepEqual(scan(`UPDATE party SET name = $1`), ['party'])
  assert.deepEqual(scan(`SELECT id FROM party WHERE $t AND status = $1`), [])
  assert.deepEqual(
    scan(`INSERT INTO audit_log (tenant_id, id, module) VALUES ($1, $2, $3)`),
    [],
    'INSERT 显式写 tenant_id 走列清单例外（值来源由文件级检查看）',
  )
  assert.deepEqual(scan(`SELECT id FROM party WHERE id = $1 /* tenant-free: 平台级统计 */`), [], '带理由的标记应放行')
  // 全局表不受租户谓词管（写入另有 GLOBAL_WRITE 检查）
  assert.deepEqual(scan(`SELECT id FROM auth_user WHERE email = $1`), [])
  // 动态表名 + 没有 $t → 拦（这才是绕过守卫的写法）
  assert.deepEqual(scan('SELECT id FROM ${TBL} WHERE status = $1'), [DYNAMIC_TABLE])
  // 动态表名 + 带 $t → 放行（同构表的通用助手是合理写法）
  assert.deepEqual(scan('SELECT ${cols} FROM ${table} WHERE $t'), [])
})

// 反例 1：纯子串 `tenant-free` 不再能豁免
test('tenant-free 必须带非空理由，空标记一律 FAIL', () => {
  assert.deepEqual(scan(`SELECT id FROM party WHERE id = $1 /* tenant-free */`), [EMPTY_REASON])
  assert.deepEqual(scan(`SELECT id FROM party WHERE id = $1 /* tenant-free:   */`), [EMPTY_REASON])
  assert.deepEqual(scan(`SELECT id FROM party WHERE id = $1 /* tenant-free:去 */`), [EMPTY_REASON], '1 个字符不算理由')

  // 文件级：没有任何理由 → FAIL，并给出「该怎么写」的提示
  const naked = `export const all = (ctx) =>\n  q(ctx, \`SELECT id FROM party WHERE id = $1 /* tenant-free */\`, [])\n`
  const bad = scanFile('x.mjs', naked)
  assert.equal(bad.length, 1, bad.join('\n'))
  assert.ok(bad[0]?.includes('tenant-free: <理由>'), '报错要提示正确写法')

  // 理由写在上一行注释里 → 放行（store/tenant.mjs、store/notify.mjs 的存量写法）
  const annotated = `// tenant-free：故意跨租户聚合\nexport const all = (ctx) =>\n  q(ctx, \`SELECT id FROM party WHERE id = $1 /* tenant-free */\`, [])\n`
  assert.deepEqual(scanFile('x.mjs', annotated), [])
})

// 反例 2：列清单有 tenant_id，但值不是从 ctx/租户上下文来的
test('INSERT 的 tenant_id 必须看得出值来源', () => {
  const code = [
    `export const okInsert = (ctx, l) =>`,
    `  exec(ctx, \`INSERT INTO audit_log (tenant_id, id, module) VALUES ($1, $2, $3)\`, [l.tenantId, l.id, l.module])`,
    ``,
    `export const badInsert = (ctx, l) =>`,
    `  exec(ctx, \`INSERT INTO audit_log (tenant_id, id, module) VALUES ($1, $2, $3)\`, [l.row.tenant_id, l.id, l.module])`,
  ].join('\n')
  const bad = scanFile('x.mjs', code)
  assert.equal(bad.length, 1, bad.join('\n'))
  assert.ok(bad[0]?.includes(UNTRACED_TENANT))
  // SQL 级别仍按列清单例外放行（值来源是文件级检查的活）
  assert.deepEqual(scan(`INSERT INTO audit_log (tenant_id, id) VALUES ($1, $2)`), [])
})

// 反例 3：全局表 auth_user 的写入（UPDATE/INSERT）必须有证据
test('全局表 auth_user 的写入必须给证据（成员校验 / 理由 / 白名单）', () => {
  const bare = `export const rename = (ctx, id, name) =>\n  exec(ctx, \`UPDATE auth_user SET display_name = $1 WHERE id = $2\`, [name, id])`
  const bad = scanFile('x.mjs', bare)
  assert.equal(bad.length, 1, bad.join('\n'))
  assert.ok(bad[0]?.includes(GLOBAL_WRITE))

  // 同一函数体里有成员校验 → 放行
  const guarded = `export const rename = (ctx, id, name) => {\n  if (!(await membership.memberExists(ctx, id))) throw new Error('not a member')\n  return exec(ctx, \`UPDATE auth_user SET display_name = $1 WHERE id = $2\`, [name, id])\n}`
  assert.deepEqual(scanFile('x.mjs', guarded), [])

  // SQL 里带合规理由 → 放行
  const marked = `export const rename = (ctx, id, name) =>\n  exec(ctx, \`UPDATE auth_user SET display_name = $1 WHERE id = $2 /* tenant-free: 平台运维改名 */\`, [name, id])`
  assert.deepEqual(scanFile('x.mjs', marked), [])

  // INSERT auth_user 同样受管
  const ins = `export const reg = (ctx, u) =>\n  exec(ctx, \`INSERT INTO auth_user (id, email) VALUES ($1, $2)\`, [u.id, u.email])`
  assert.ok(scanFile('x.mjs', ins).some((p) => p.includes(GLOBAL_WRITE)))
})

test('GLOBAL_WRITE 白名单不腐化：每个 key 的文件与函数都真实存在', async () => {
  for (const key of Object.keys(GLOBAL_WRITE_ALLOW)) {
    const [file, fn] = key.split(':')
    const code = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.ok(
      code.includes(`const ${fn} `) || code.includes(`function ${fn}(`),
      `${key} 指向的函数不存在了，白名单该删`,
    )
  }
})

test('store/**/*.mjs 全部通过租户守卫（含子目录）', async () => {
  /** @type {string[]} */
  const bad = []
  for (const f of await storeFiles()) {
    const code = await readFile(new URL(`../store/${f}`, import.meta.url), 'utf8')
    bad.push(...scanFile(f, code))
  }
  assert.deepEqual(bad, [], `租户守卫失败:\n${bad.join('\n')}`)
})
