import { exec, one } from '../db/index.mjs'

// 全局表：登录/注册尝试，与业务同库（不引 Redis）
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
 * 窗口内次数。ident / ip / kind 都可选，条件按需拼（只有白名单常量，不拼用户输入）
 * @param {any} ctx
 * @param {{ ident?: string, ip?: string, kind?: string, since: Date, onlyFailures?: boolean }} f
 */
export async function count(ctx, f) {
  /** @type {string[]} */
  const cond = []
  /** @type {unknown[]} */
  const args = []
  // push 返回新长度，正好当占位符序号用
  cond.push(`at > $${args.push(f.since)}`)
  if (f.ident) cond.push(`ident = $${args.push(f.ident)}`)
  else if (f.ip) cond.push(`ip = $${args.push(f.ip)}`)
  if (f.kind) cond.push(`kind = $${args.push(f.kind)}`)
  if (f.onlyFailures) cond.push(`ok = $${args.push(false)}`)
  const row = await one(ctx, `SELECT COUNT(*) AS n FROM login_attempt WHERE ${cond.join(' AND ')}`, args)
  return Number(row?.n ?? 0)
}
