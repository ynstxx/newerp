/**
 * 类型映射 + DDL 生成 + 结构归一化。方言差异只允许出现在这个文件里。
 */

/** 声明类型 → 两库物理类型。新增类型只加一行。 */
/** @type {Record<string, { pg: string, mysql: string }>} */
export const TYPES = {
  uuid: { pg: 'uuid', mysql: 'char(36)' },
  code: { pg: 'character varying(64)', mysql: 'varchar(64)' },
  text: { pg: 'text', mysql: 'text' },
  money: { pg: 'numeric(18,2)', mysql: 'decimal(18,2)' },
  int: { pg: 'integer', mysql: 'int' },
  bigint: { pg: 'bigint', mysql: 'bigint' },
  bool: { pg: 'boolean', mysql: 'tinyint(1)' },
  time: { pg: 'timestamp with time zone', mysql: 'datetime(3)' },
  json: { pg: 'jsonb', mysql: 'json' },
}

/**
 * @typedef {object} Table
 * @property {string} name
 * @property {boolean} tenant
 * @property {string[]} [pk]      声明主键；未声明则 (tenant_id,) id
 * @property {{ n: string, t: string, notNull?: boolean }[]} cols
 * @property {string[][]} [uniq]
 * @property {string[][]} [index]
 * @property {{ cols: string[], ref: string }[]} [fk]
 */

/**
 * @typedef {object} RTable  已解析（tenant_id 补全）的表结构
 * @property {string} name
 * @property {boolean} tenant
 * @property {{ n: string, t: string, notNull: boolean }[]} cols
 * @property {string[]} pk
 * @property {string[][]} uniq
 * @property {string[][]} index
 * @property {{ cols: string[], ref: string, refCols: string[] }[]} fk
 */

/**
 * @param {Table[]} tables
 * @returns {Record<string, RTable>}
 */
export function canonical(tables) {
  /** @type {Record<string, RTable>} */
  const out = {}
  for (const t of tables) {
    const pk = t.pk ?? (t.tenant ? ['tenant_id', 'id'] : ['id'])
    /** @type {{ n: string, t: string, notNull: boolean }[]} */
    const cols = []
    if (!t.pk) {
      if (t.tenant) cols.push({ n: 'tenant_id', t: 'uuid', notNull: true })
      cols.push({ n: 'id', t: 'uuid', notNull: true })
    }
    for (const c of t.cols) cols.push({ n: c.n, t: c.t, notNull: Boolean(c.notNull) })
    // 主键里声明了但没写的列（如 org_membership.tenant_id）自动补 uuid 非空
    for (const k of pk) if (!cols.some((c) => c.n === k)) cols.push({ n: k, t: 'uuid', notNull: true })

    const pre = (/** @type {string[]} */ cs) => (t.tenant ? ['tenant_id', ...cs] : [...cs])
    out[t.name] = {
      name: t.name,
      tenant: t.tenant,
      cols,
      pk: [...pk],
      uniq: (t.uniq ?? []).map(pre),
      index: (t.index ?? []).map(pre),
      fk: (t.fk ?? []).map((f) => ({
        cols: pre(f.cols),
        ref: f.ref,
        refCols: t.tenant ? ['tenant_id', 'id'] : ['id'],
      })),
    }
  }
  return out
}

/**
 * @param {string} dialect
 * @param {string} token
 */
function colType(dialect, token) {
  const t = TYPES[token]
  if (!t) throw new Error(`未知类型 ${token}`)
  return dialect === 'mysql' ? t.mysql : t.pg
}

/** 索引名：两库都 ≤64，且按 (表,列) 唯一 */
export const idxName = (/** @type {string} */ prefix, /** @type {RTable} */ t, /** @type {string[]} */ cols) =>
  `${prefix}_${t.name}_${cols.join('_')}`.slice(0, 60)

/**
 * @param {RTable} t
 * @param {'pg'|'mysql'} dialect
 * @param {boolean} [ifNotExists]
 */
export function createTable(t, dialect, ifNotExists = false) {
  const tq = dialect === 'mysql' ? '`' : '"'
  const collate = dialect === 'pg' ? ' COLLATE "C"' : ''
  const lines = t.cols.map((c) => {
    const type = colType(dialect, c.t)
    const coll = dialect === 'pg' && (c.t === 'code' || c.t === 'text') ? collate : ''
    return `  ${tq}${c.n}${tq} ${type}${coll}${c.notNull ? ' NOT NULL' : ''}`
  })
  lines.push(`  PRIMARY KEY (${t.pk.map((n) => `${tq}${n}${tq}`).join(', ')})`)
  // 唯一约束写成 CONSTRAINT 而不是 CREATE UNIQUE INDEX：
  // 两库的 information_schema.table_constraints 都看得到，漂移比对才成立
  for (const u of t.uniq) {
    lines.push(
      `  CONSTRAINT ${tq}${idxName('uq', t, u)}${tq} UNIQUE (${u.map((n) => `${tq}${n}${tq}`).join(', ')})`,
    )
  }
  for (const f of t.fk) {
    lines.push(
      `  CONSTRAINT ${tq}${idxName('fk', t, f.cols)}${tq} FOREIGN KEY (${f.cols.map((n) => `${tq}${n}${tq}`).join(', ')})` +
        ` REFERENCES ${tq}${f.ref}${tq} (${f.refCols.map((n) => `${tq}${n}${tq}`).join(', ')})`,
    )
  }
  const tail = dialect === 'mysql' ? '\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci' : '\n)'
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${tq}${t.name}${tq} (\n${lines.join(',\n')}${tail};`
}

/**
 * 普通索引（唯一约束在 createTable 里以 CONSTRAINT 形式发出）
 * @param {RTable} t
 * @param {'pg'|'mysql'} dialect
 */
export function createIndexes(t, dialect) {
  const tq = dialect === 'mysql' ? '`' : '"'
  return t.index.map(
    (i) =>
      `CREATE INDEX ${tq}${idxName('idx', t, i)}${tq} ON ${tq}${t.name}${tq} (${i.map((n) => `${tq}${n}${tq}`).join(', ')});`,
  )
}

/**
 * 声明结构 vs 快照 → 语句列表。
 * 故意不做：主键变更（危险，人工写）、纯索引增删（性能项，S7 上双库比对再说）
 * ponytail: 只覆盖 建表/加列/删列/改列/唯一约束，够 M0-M7 用
 * @param {Record<string, RTable>} prev
 * @param {Record<string, RTable>} next
 * @param {'pg'|'mysql'} dialect
 */
export function diff(prev, next, dialect) {
  const tq = dialect === 'mysql' ? '`' : '"'
  /** @type {string[]} */
  const out = []
  const q = (/** @type {string} */ s) => `${tq}${s}${tq}`

  for (const [name, t] of Object.entries(next)) {
    const old = prev[name]
    if (!old) {
      out.push(createTable(t, dialect), ...createIndexes(t, dialect))
      continue
    }
    if (JSON.stringify(old.pk) !== JSON.stringify(t.pk)) {
      throw new Error(`表 ${name} 的主键变更不会自动生成，请手写迁移（旧 ${old.pk} → 新 ${t.pk}）`)
    }
    const oldCols = new Map(old.cols.map((c) => [c.n, c]))
    const newCols = new Map(t.cols.map((c) => [c.n, c]))
    for (const c of t.cols) {
      const o = oldCols.get(c.n)
      if (!o) {
        out.push(`ALTER TABLE ${q(name)} ADD COLUMN ${q(c.n)} ${colType(dialect, c.t)}${c.notNull ? ' NOT NULL' : ''};`)
        continue
      }
      if (o.t !== c.t) {
        out.push(
          dialect === 'mysql'
            ? `ALTER TABLE ${q(name)} MODIFY COLUMN ${q(c.n)} ${colType(dialect, c.t)}${c.notNull ? ' NOT NULL' : ''};`
            : `ALTER TABLE ${q(name)} ALTER COLUMN ${q(c.n)} TYPE ${colType(dialect, c.t)};`,
        )
      }
      if (o.notNull !== c.notNull) {
        out.push(
          `ALTER TABLE ${q(name)} ALTER COLUMN ${q(c.n)} ${c.notNull ? 'SET' : 'DROP'} NOT NULL;`,
        )
      }
    }
    for (const c of old.cols) if (!newCols.has(c.n)) out.push(`ALTER TABLE ${q(name)} DROP COLUMN ${q(c.n)};`)

    const oldU = new Set(old.uniq.map((u) => u.join(',')))
    const newU = new Set(t.uniq.map((u) => u.join(',')))
    for (const u of t.uniq)
      if (!oldU.has(u.join(',')))
        out.push(`ALTER TABLE ${q(name)} ADD CONSTRAINT ${q(idxName('uq', t, u))} UNIQUE (${u.map(q).join(', ')});`)
    for (const u of old.uniq)
      if (!newU.has(u.join(',')))
        out.push(
          dialect === 'mysql'
            ? `ALTER TABLE ${q(name)} DROP INDEX ${q(idxName('uq', old, u))};`
            : `ALTER TABLE ${q(name)} DROP CONSTRAINT ${q(idxName('uq', old, u))};`,
        )
  }

  for (const name of Object.keys(prev)) {
    if (!next[name]) out.push(`DROP TABLE ${q(name)};`)
  }
  return out
}

// ── 实际库结构 → 与 canonical() 同形状，用于 check ──────────────────────────

/** @type {Record<string, { columns: string, keys: string }>} */
const META_SQL = {
  pg: {
    columns: `SELECT table_name, column_name, udt_name, character_maximum_length, numeric_precision, numeric_scale, is_nullable
              FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    keys: `SELECT tc.table_name, tc.constraint_type, tc.constraint_name, kcu.column_name, kcu.ordinal_position
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
           WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
           ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name, kcu.ordinal_position`,
  },
  mysql: {
    columns: `SELECT table_name, column_name, column_type, is_nullable
              FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`,
    keys: `SELECT tc.table_name, tc.constraint_type, tc.constraint_name, kcu.column_name, kcu.ordinal_position
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
           WHERE tc.table_schema = DATABASE() AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
           ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name, kcu.ordinal_position`,
  },
}

/** PG 的 udt_name + 长度/精度 → 与 TYPES.pg 同形字符串 */
function pgPhysicalType(/** @type {any} */ r) {
  switch (r.udt_name) {
    case 'varchar':
      return `character varying(${r.character_maximum_length})`
    case 'numeric':
      return `numeric(${r.numeric_precision},${r.numeric_scale})`
    case 'int4':
      return 'integer'
    case 'int8':
      return 'bigint'
    case 'bool':
      return 'boolean'
    case 'timestamptz':
      return 'timestamp with time zone'
    default:
      return r.udt_name
  }
}

/**
 * @param {any} adapter
 * @returns {Promise<Record<string, { cols: { n: string, t: string, notNull: boolean }[], pk: string[], uniq: string[][] }>>}
 */
export async function describeActual(adapter) {
  const dialect = /** @type {'pg'|'mysql'} */ (adapter.dialect)
  const meta = META_SQL[dialect]
  // MySQL 8 的 information_schema 列名是大写，统一降为小写（PG 本来就是小写）
  const lower = (/** @type {any[]} */ rows) =>
    dialect === 'mysql'
      ? rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])))
      : rows
  const colRows = lower(await adapter.all(meta.columns, []))
  const keyRows = lower(await adapter.all(meta.keys, []))

  /** @type {Record<string, any>} */
  const out = {}
  const bucket = (/** @type {string} */ n) => (out[n] ??= { cols: [], pk: [], uniq: [] })

  // 反查：物理类型 → 声明 token
  const reverse = new Map(
    Object.entries(TYPES).map(([token, m]) => [dialect === 'mysql' ? m.mysql : m.pg, token]),
  )

  for (const r of colRows) {
    if (r.table_name === 'schema_migration') continue // 迁移器元表，不参与漂移比对
    const phys = dialect === 'mysql' ? r.column_type : pgPhysicalType(r)
    const token = reverse.get(phys)
    if (!token) throw new Error(`${dialect} 出现未映射的物理类型 ${phys}（${r.table_name}.${r.column_name}）`)
    bucket(r.table_name).cols.push({ n: r.column_name, t: token, notNull: r.is_nullable === 'NO' })
  }

  /** @type {Record<string, { type: string, cols: string[] }>} */
  const cons = {}
  for (const r of keyRows) {
    if (r.table_name === 'schema_migration') continue
    const c = (cons[`${r.table_name}\u0000${r.constraint_name}`] ??= { type: r.constraint_type, cols: [] })
    c.cols.push(r.column_name)
  }
  for (const [k, c] of Object.entries(cons)) {
    const table = k.split('\u0000')[0]
    if (c.type === 'PRIMARY KEY') bucket(table).pk = c.cols
    else bucket(table).uniq.push(c.cols)
  }
  return out
}

/**
 * 比对声明与库内结构，返回人读差异
 * @param {Record<string, RTable>} declared
 * @param {Record<string, any>} actual
 */
export function compare(declared, actual) {
  /** @type {string[]} */
  const problems = []
  for (const [name, d] of Object.entries(declared)) {
    const a = actual[name]
    if (!a) {
      problems.push(`缺表 ${name}`)
      continue
    }
    const aCols = new Map(a.cols.map((/** @type {any} */ c) => [c.n, c]))
    for (const c of d.cols) {
      const ac = aCols.get(c.n)
      if (!ac) {
        problems.push(`${name}.${c.n} 缺列`)
        continue
      }
      if (ac.t !== c.t) problems.push(`${name}.${c.n} 类型 ${ac.t} ≠ ${c.t}`)
      if (ac.notNull !== c.notNull) problems.push(`${name}.${c.n} 非空 ${ac.notNull} ≠ ${c.notNull}`)
    }
    const dCols = new Set(d.cols.map((c) => c.n))
    for (const c of a.cols) if (!dCols.has(c.n)) problems.push(`${name}.${c.n} 多了列`)
    if (d.pk.join(',') !== a.pk.join(',')) problems.push(`${name} 主键 [${a.pk}] ≠ [${d.pk}]`)
    const dU = new Set(d.uniq.map((/** @type {string[]} */ u) => u.join(',')))
    const aU = new Set(a.uniq.map((/** @type {string[]} */ u) => u.join(',')))
    for (const u of dU) if (!aU.has(u)) problems.push(`${name} 缺唯一约束 (${u})`)
    for (const u of aU) if (!dU.has(u)) problems.push(`${name} 多了唯一约束 (${u})`)
  }
  for (const name of Object.keys(actual)) if (!declared[name]) problems.push(`多了表 ${name}`)
  return problems
}
