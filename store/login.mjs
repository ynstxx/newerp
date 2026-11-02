import { exec, one } from '../db/index.mjs'

// 全局表：登录失败计数，与登录本身同库（不引 Redis）
/**
 * @param {any} ctx
 * @param {{ id: string, kind: string, ident: string, ip: string | null, ok: boolean, at: Date }} a
 */
export const record = (ctx, a) =>
  exec(
    ctx,
    `INSERT INTO login_attempt (id, kind, ident, ip, ok, at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [a.id, a.kind, a.ident, a.ip, a.ok, a.at],
  )

/**
 * 窗口内失败次数。ident 为空时按 IP 统计。
 * @param {any} ctx
 * @param {{ ident?: string, ip?: string, since: Date }} f
 */
export const countFailures = async (ctx, f) => {
  const sql = f.ident
    ? `SELECT COUNT(*) AS n FROM login_attempt WHERE ident = $1 AND ok = $2 AND at > $3`
    : `SELECT COUNT(*) AS n FROM login_attempt WHERE ip = $1 AND ok = $2 AND at > $3`
  const row = await one(ctx, sql, [f.ident ?? f.ip, false, f.since])
  return Number(row?.n ?? 0)
}
