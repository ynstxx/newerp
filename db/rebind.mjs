/**
 * `$1` 占位符 → MySQL 的 `?`，并按出现顺序重排参数。
 * 顺序重排是必需的：`$t` 展开后租户参数可能落在末尾，而 `?` 必须按位置传。
 * ponytail: 正则扫占位符，不做 SQL 词法分析；本项目 SQL 里没有 $ 字面量
 */

/**
 * @param {string} sql
 * @param {unknown[]} args
 * @returns {{ sql: string, args: unknown[] }}
 */
export function rebind(sql, args) {
  /** @type {number[]} */
  const order = []
  const out = sql.replace(/\$(\d+)/g, (_, d) => {
    order.push(Number(d) - 1)
    return '?'
  })
  return { sql: out, args: order.map((i) => args[i]) }
}
