import mysql from 'mysql2/promise'
import { config } from '../config.mjs'

/** @param {any} row */
function normalizeRow(row) {
  for (const k of Object.keys(row)) {
    const v = row[k]
    if (v instanceof Date) row[k] = v.toISOString()
    else if (Buffer.isBuffer(v)) row[k] = v.toString('utf8')
  }
  return row
}

/** tinyint(1) 当布尔，与 PG 的 boolean 对齐 */
const typeCast = (/** @type {any} */ field, /** @type {any} */ next) => {
  if (field.type === 'TINY' && field.length === 1) return field.string() === '1'
  return next()
}

export async function createAdapter() {
  const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    connectionLimit: 10,
    connectTimeout: 3000,
    supportBigNumbers: true,
    bigNumberStrings: true,
    typeCast,
    charset: 'utf8mb4',
  })

  /** @type {(c: any) => any} */
  const connOf = (c) => ({
    /** @param {string} sql @param {unknown[]} [args] */
    async all(sql, args = []) {
      const [rows] = await c.query(sql, args)
      return Array.isArray(rows) ? rows.map(normalizeRow) : []
    },
    /** @param {string} sql @param {unknown[]} [args] */
    async run(sql, args = []) {
      const [r] = await c.query(sql, args)
      return Number(r?.affectedRows ?? 0)
    },
  })

  const pooled = connOf(pool)

  return {
    dialect: /** @type {const} */ ('mysql'),
    all: (/** @type {string} */ sql, /** @type {unknown[]} */ args, /** @type {any} */ conn) =>
      conn ? conn.all(sql, args) : pooled.all(sql, args),
    run: (/** @type {string} */ sql, /** @type {unknown[]} */ args, /** @type {any} */ conn) =>
      conn ? conn.run(sql, args) : pooled.run(sql, args),
    async acquire() {
      const client = await pool.getConnection()
      const base = connOf(client)
      return {
        all: base.all,
        run: base.run,
        txBegin: () => client.beginTransaction(),
        txCommit: () => client.commit(),
        txRollback: () => client.rollback(),
        release: () => client.release(),
      }
    },
    async end() {
      await pool.end()
    },
  }
}
