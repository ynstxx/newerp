/**
 * 单据编号序列。每个租户 × 前缀 × 年度一条，n 是已发出的最大序号。
 * 用一张表而不是「查 MAX(code)+1」：后者在并发下会算出同一个号，
 * 而且不同单据表要各写一遍。
 */
export const tables = [
  {
    name: 'code_seq',
    tenant: true,
    cols: [
      { n: 'prefix', t: 'code', notNull: true },
      { n: 'period', t: 'code', notNull: true },
      { n: 'n', t: 'int', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['prefix', 'period']],
  },
]
