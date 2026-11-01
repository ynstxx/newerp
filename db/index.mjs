import { config } from '../config.mjs'
import { rebind } from './rebind.mjs'

/** @type {any} */
let adapter = null

export async function connect() {
  if (!adapter) {
    const mod = config.db.driver === 'mysql' ? await import('./mysql.mjs') : await import('./pg.mjs')
    adapter = await mod.createAdapter()
  }
  return adapter
}

export async function close() {
  if (adapter) await adapter.end()
  adapter = null
}

/**
 * `$t` → `tenant_id = $N`，租户值永远取自 ctx，追加在参数末尾（不改动调用方的 $1..$n 编号）。
 * 缺 ctx.tenantId 直接抛错 —— 宁可炸，不可越权。
 * @param {{ tenantId?: string | null } | null | undefined} ctx
 * @param {string} sql
 * @param {unknown[]} [args]
 */
export function prepare(ctx, sql, args = []) {
  if (!sql.includes('$t')) return { sql, args }
  const tenantId = ctx?.tenantId
  if (!tenantId) throw new Error(`SQL 含 $t 但 ctx.tenantId 为空: ${sql.slice(0, 80)}`)
  return { sql: sql.replace(/\$t/g, `tenant_id = $${args.length + 1}`), args: [...args, tenantId] }
}

/**
 * 方言落地：MySQL 需要把 $n 换成 ? 并重排参数
 * @param {any} a
 * @param {string} sql
 * @param {unknown[]} args
 */
function dialectize(a, sql, args) {
  return a.dialect === 'mysql' ? rebind(sql, args) : { sql, args }
}

/**
 * @template T
 * @param {any} ctx
 * @param {string} sql
 * @param {unknown[]} [args]
 * @returns {Promise<T[]>}
 */
export async function q(ctx, sql, args = []) {
  const a = await connect()
  const p = prepare(ctx, sql, args)
  const d = dialectize(a, p.sql, p.args)
  return a.all(d.sql, d.args, ctx?.conn)
}

/**
 * @template T
 * @param {any} ctx
 * @param {string} sql
 * @param {unknown[]} [args]
 * @returns {Promise<T | null>}
 */
export async function one(ctx, sql, args = []) {
  const rows = await q(ctx, sql, args)
  return rows[0] ?? null
}

/**
 * 影响行数
 * @param {any} ctx
 * @param {string} sql
 * @param {unknown[]} [args]
 */
export async function exec(ctx, sql, args = []) {
  const a = await connect()
  const p = prepare(ctx, sql, args)
  const d = dialectize(a, p.sql, p.args)
  return a.run(d.sql, d.args, ctx?.conn)
}

/**
 * 唯一开事务的地方。嵌套调用复用外层事务（不 savepoint）。
 * @template T
 * @param {any} ctx
 * @param {(ctx: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTx(ctx, fn) {
  if (ctx?.conn) return fn(ctx)
  const a = await connect()
  const conn = await a.acquire()
  try {
    await conn.txBegin()
    const out = await fn({ ...ctx, conn })
    await conn.txCommit()
    return out
  } catch (err) {
    await conn.txRollback().catch(() => {})
    throw err
  } finally {
    conn.release()
  }
}
