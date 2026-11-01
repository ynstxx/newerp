import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tables, metaTable } from '../schema/index.mjs'
import { canonical, compare, createTable, describeActual, diff } from './ddl.mjs'
import { connect } from './index.mjs'
import { rebind } from './rebind.mjs'

const SNAPSHOT = new URL('../schema/snapshot.json', import.meta.url)
const DIR = { pg: '../migrations/pg/', mysql: '../migrations/mysql/' }
const LOCK_KEY = 987654321

/** 迁移器自己的元表：必须早于任何迁移存在，所以不走 migrations/ */
const META = canonical([metaTable]).schema_migration

/**
 * 切分 .sql 成语句。跳过 -- 行注释与 '…' / "…" 字符串内的分号。
 * ponytail: 不处理 '' 转义与 $$ 块，本项目 DDL 里没有
 * @param {string} sql
 */
export function splitStatements(sql) {
  /** @type {string[]} */
  const out = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
      cur += '\n'
      continue
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex')

// 迁移器直接拿连接跑，绕开 q()；但占位符仍需按方言转换
const runOn = (/** @type {any} */ a, /** @type {any} */ c, /** @type {string} */ sql, /** @type {unknown[]} */ args = []) => {
  const d = a.dialect === 'mysql' ? rebind(sql, args) : { sql, args }
  return c.run(d.sql, d.args)
}
const allOn = (/** @type {any} */ a, /** @type {any} */ c, /** @type {string} */ sql, /** @type {unknown[]} */ args = []) => {
  const d = a.dialect === 'mysql' ? rebind(sql, args) : { sql, args }
  return c.all(d.sql, d.args)
}

/**
 * 生成双库迁移文件 + 更新快照
 * @param {string} name 如 0002_add_project
 */
export async function gen(name) {
  const next = canonical(tables)
  /** @type {Record<string, any>} */
  const prev = existsSync(SNAPSHOT) ? JSON.parse(await readFile(SNAPSHOT, 'utf8')) : {}
  let wrote = 0
  for (const driver of /** @type {const} */ (['pg', 'mysql'])) {
    const stmts = diff(prev, next, driver)
    if (!stmts.length) continue
    const dir = new URL(DIR[driver], import.meta.url)
    await mkdir(dir, { recursive: true })
    const file = new URL(`${name}.sql`, dir)
    const body = `-- ${name} · ${driver} · 由 cmd/migrate.mjs gen 生成，勿手改\n-- 表数 ${Object.keys(next).length} · 语句 ${stmts.length} · ${new Date().toISOString()}\n\n${stmts.join('\n\n')}\n`
    await writeFile(file, body, 'utf8')
    console.log(`写出 ${file.pathname} (${stmts.length} 条语句)`)
    wrote++
  }
  if (!wrote) return console.log('无结构变更，未生成文件')
  await writeFile(SNAPSHOT, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  console.log(`快照已更新 schema/snapshot.json`)
}

/** 迁移文件列表（按版本名排序） */
async function files(/** @type {'pg'|'mysql'} */ driver) {
  const dir = new URL(DIR[driver], import.meta.url)
  if (!existsSync(dir)) return []
  return (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
}

/** 建表 + 加锁，返回持有锁的连接 */
async function locked() {
  const a = await connect()
  const conn = await a.acquire()
  await runOn(a, conn, createTable(META, /** @type {'pg'|'mysql'} */ (a.dialect), true))
  if (a.dialect === 'mysql') await allOn(a, conn, `SELECT GET_LOCK('newerp_migrate', 30) AS ok`)
  else await allOn(a, conn, `SELECT pg_advisory_lock($1)`, [LOCK_KEY])
  return { a, conn }
}

async function unlocked(/** @type {any} */ a, /** @type {any} */ conn) {
  if (a.dialect === 'mysql') await allOn(a, conn, `SELECT RELEASE_LOCK('newerp_migrate')`)
  else await allOn(a, conn, `SELECT pg_advisory_unlock($1)`, [LOCK_KEY])
  conn.release()
  await a.end()
}

export async function up() {
  const { a, conn } = await locked()
  const driver = /** @type {'pg'|'mysql'} */ (a.dialect)
  try {
    const applied = new Map(
      (await allOn(a, conn, `SELECT version, checksum FROM schema_migration`)).map((/** @type {any} */ r) => [
        r.version,
        r.checksum,
      ]),
    )
    let n = 0
    for (const f of await files(driver)) {
      const version = f.replace(/\.sql$/, '')
      const sql = await readFile(new URL(f, new URL(DIR[driver], import.meta.url)), 'utf8')
      const checksum = sha(sql)
      if (applied.has(version)) {
        if (applied.get(version) !== checksum) {
          throw new Error(`迁移 ${version} 已被修改但已应用过 —— 新增 000N_*.sql，不要改历史文件`)
        }
        continue
      }
      const stmts = splitStatements(sql)
      if (driver === 'pg') await runOn(a, conn, 'BEGIN')
      try {
        for (const s of stmts) await runOn(a, conn, s)
        await runOn(a, conn, `INSERT INTO schema_migration (version, checksum, applied_at) VALUES ($1, $2, $3)`, [
          version,
          checksum,
          new Date(),
        ])
        if (driver === 'pg') await runOn(a, conn, 'COMMIT')
      } catch (err) {
        if (driver === 'pg') await runOn(a, conn, 'ROLLBACK')
        const hint =
          driver === 'mysql' ? '（MySQL 的 DDL 非事务，库可能处于半迁移状态：清库后重跑）' : ''
        throw new Error(`迁移 ${version} 失败${hint}: ${/** @type {Error} */ (err).message}`)
      }
      console.log(`已应用 ${version} (${stmts.length} 条语句)`)
      n++
    }
    if (!n) console.log(`无待应用迁移（${driver}）`)
  } finally {
    await unlocked(a, conn)
  }
}

/** 声明结构 vs 实际库结构 */
export async function check() {
  const a = await connect()
  try {
    const problems = compare(canonical(tables), await describeActual(a))
    if (!problems.length) {
      console.log(`结构与声明一致（${a.dialect}，${Object.keys(canonical(tables)).length} 表）`)
      return 0
    }
    console.log(`发现 ${problems.length} 处漂移（${a.dialect}）：`)
    for (const p of problems) console.log(`  - ${p}`)
    return problems.length
  } finally {
    await a.end()
  }
}
