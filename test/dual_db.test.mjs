import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.mjs'
import { canonical, compare, describeActual } from '../db/ddl.mjs'
import { tables } from '../schema/index.mjs'

/**
 * 双库结构等价门禁：同一个 schema 声明，两边建出来的东西归一化后必须逐字节一致。
 * 这是"PostgreSQL 16+ 与 MySQL 8.0+ 都必须能跑"的唯一硬证据。
 * CI 的 dual 作业里两个库都在；单库矩阵作业里这个文件会跳过。
 */
const PG_PORT = Number(process.env.DUAL_PG_PORT ?? 5433)
const MYSQL_PORT = Number(process.env.DUAL_MYSQL_PORT ?? 3308)

/**
 * 临时指向某个方言建一个适配器。db/*.mjs 的 createAdapter 读 config.db，所以改完要还原。
 * @param {'pg'|'mysql'} driver
 * @param {number} port
 */
async function adapterFor(driver, port) {
  const saved = { ...config.db }
  config.db.driver = driver
  config.db.port = port
  try {
    const mod = driver === 'mysql' ? await import('../db/mysql.mjs') : await import('../db/pg.mjs')
    return await mod.createAdapter()
  } finally {
    config.db.driver = saved.driver
    config.db.port = saved.port
  }
}

/**
 * @param {'pg'|'mysql'} driver
 * @param {number} port
 * @returns {Promise<any | null>}
 */
async function tryAdapter(driver, port) {
  try {
    const a = await adapterFor(driver, port)
    await a.all('SELECT 1 AS ok', [], undefined)
    return a
  } catch {
    return null
  }
}

test('双库结构等价：declared 与两边实际结构都对得上', async (t) => {
  const pg = await tryAdapter('pg', PG_PORT)
  const my = await tryAdapter('mysql', MYSQL_PORT)
  if (!pg || !my) {
    if (pg) await pg.end()
    if (my) await my.end()
    return t.skip(`需要两个库都可达（pg:${PG_PORT} ${pg ? '√' : '×'} / mysql:${MYSQL_PORT} ${my ? '√' : '×'}）`)
  }

  try {
    const declared = canonical(tables)
    const pgActual = await describeActual(pg)
    const myActual = await describeActual(my)

    assert.deepEqual(compare(declared, pgActual), [], 'PG 与声明不一致')
    assert.deepEqual(compare(declared, myActual), [], 'MySQL 与声明不一致')

    // 归一化后的表集合必须一模一样（多一张/少一张都算失败）
    assert.deepEqual(Object.keys(pgActual).sort(), Object.keys(myActual).sort())

    for (const name of Object.keys(pgActual).sort()) {
      const p = pgActual[name]
      const m = myActual[name]
      assert.deepEqual(
        p.cols.map((/** @type {any} */ c) => `${c.n}:${c.t}${c.notNull ? '!' : ''}`),
        m.cols.map((/** @type {any} */ c) => `${c.n}:${c.t}${c.notNull ? '!' : ''}`),
        `${name} 列定义不一致`,
      )
      assert.deepEqual(p.pk, m.pk, `${name} 主键不一致`)
      assert.deepEqual(
        p.uniq.map((/** @type {string[]} */ u) => u.join(',')).sort(),
        m.uniq.map((/** @type {string[]} */ u) => u.join(',')).sort(),
        `${name} 唯一约束不一致`,
      )
    }
  } finally {
    await pg.end()
    await my.end()
  }
})

test('双库禁用清单：生成的 DDL 里零出现', async (t) => {
  const { createTable } = await import('../db/ddl.mjs')
  const declared = canonical(tables)
  const forbidden = [
    [/\bRETURNING\b/i, 'RETURNING'],
    [/LAST_INSERT_ID/i, 'LAST_INSERT_ID'],
    [/\bnow\s*\(\s*\)/i, 'now()'],
    [/CURRENT_TIMESTAMP/i, 'CURRENT_TIMESTAMP'],
    [/\bGENERATED\b/i, '生成列'],
    [/\bAUTO_INCREMENT\b/i, '自增'],
  ]
  for (const dialect of /** @type {const} */ (['pg', 'mysql'])) {
    for (const table of Object.values(declared)) {
      const sql = createTable(table, dialect)
      for (const [re, label] of forbidden) {
        assert.doesNotMatch(sql, /** @type {RegExp} */ (re), `${table.name}@${dialect} 用了 ${label}`)
      }
    }
  }
  t.diagnostic('禁用清单检查完成')
})
