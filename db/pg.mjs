import pg from 'pg'
import { config } from '../config.mjs'

/** @param {any} row */
function normalizeRow(row) {
  for (const k of Object.keys(row)) {
    const v = row[k]
    if (v instanceof Date) row[k] = v.toISOString()
  }
  return row
}

export async function createAdapter() {
  const pool = new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    max: 10,
    connectionTimeoutMillis: 3000, // 健康检查不能被一个挂掉的库拖死
  })

  /** @type {(c: any) => any} */
  const connOf = (c) => ({
    /** @param {string} sql @param {unknown[]} [args] */
    async all(sql, args = []) {
      const r = await c.query(sql, args)
      return r.rows.map(normalizeRow)
    },
    /** @param {string} sql @param {unknown[]} [args] */
    async run(sql, args = []) {
      const r = await c.query(sql, args)
      return r.rowCount ?? 0
    },
  })

  const pooled = connOf(pool)

  return {
    dialect: /** @type {const} */ ('pg'),
    all: (/** @type {string} */ sql, /** @type {unknown[]} */ args, /** @type {any} */ conn) =>
      conn ? conn.all(sql, args) : pooled.all(sql, args),
    run: (/** @type {string} */ sql, /** @type {unknown[]} */ args, /** @type {any} */ conn) =>
      conn ? conn.run(sql, args) : pooled.run(sql, args),
    async acquire() {
      const client = await pool.connect()
      const base = connOf(client)
      return {
        all: base.all,
        run: base.run,
        txBegin: async () => void (await client.query('BEGIN')),
        txCommit: async () => void (await client.query('COMMIT')),
        txRollback: async () => void (await client.query('ROLLBACK')),
        release: () => client.release(),
      }
    },
    async end() {
      await pool.end()
    },
  }
}
