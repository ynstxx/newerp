import { platformTables, metaTable } from './platform.mjs'
import { partyTables } from './party.mjs'
import { projectTables } from './project.mjs'

/** 表结构单一真源（不含迁移器自己的 schema_migration）。新增表只加到这里。 */
export const tables = [...platformTables, ...partyTables, ...projectTables]

export { metaTable }
