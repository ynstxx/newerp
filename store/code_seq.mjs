import { randomUUID } from 'node:crypto'
import { exec, one } from '../db/index.mjs'

// 租户表：单据编号序列
/**
 * 序号 +1。影响 0 行说明这条序列还没建，插入第一条。
 * 调用方必须包在事务里：UPDATE 会拿行锁，并发请求会排队。
 * @param {any} ctx
 * @param {{ prefix: string, period: string, now: Date }} p
 */
export async function bump(ctx, p) {
  const n = await exec(
    ctx,
    `UPDATE code_seq SET n = n + 1, updated_at = $1 WHERE $t AND prefix = $2 AND period = $3`,
    [p.now, p.prefix, p.period],
  )
  if (n === 0) {
    await exec(
      ctx,
      `INSERT INTO code_seq (tenant_id, id, prefix, period, n, updated_at) VALUES ($1, $2, $3, $4, 1, $5)`,
      [ctx.tenantId, randomUUID(), p.prefix, p.period, p.now],
    )
  }
  const row = await one(ctx, `SELECT n FROM code_seq WHERE $t AND prefix = $1 AND period = $2`, [
    p.prefix,
    p.period,
  ])
  return Number(row?.n ?? 0)
}
