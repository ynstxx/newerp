import { readdirSync } from 'node:fs'

/**
 * 表结构单一真源 = schema/ 目录下所有 *.mjs（除本文件）导出的 `tables` 数组。
 * 自动发现而不是手写 import 清单 —— 否则每来一个新的业务域就要改这个文件，
 * 多人/多 Agent 并行时这里会变成唯一排队点。
 *
 * 约定（新增域照这个来）：
 *   schema/<域名>.mjs   →  export const tables = [ ... ]
 *   FK 指向的表可以出现在任何文件里，ddl 生成时会按依赖拓扑排序
 */

const DIR = new URL('./', import.meta.url)

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.mjs') && f !== 'index.mjs')
  .sort()

/** @type {any[]} */
const mods = []
for (const f of files) mods.push(await import(new URL(f, DIR).href))

/** @type {any[]} */
export const tables = []
/** @type {any} */
let metaTable = null
for (const m of mods) {
  if (Array.isArray(m.tables)) tables.push(...m.tables)
  if (m.metaTable) metaTable = m.metaTable
}

if (!metaTable) throw new Error('schema/ 下必须有一个文件导出 metaTable（迁移器元表）')

export { metaTable }
