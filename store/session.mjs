import { exec, one } from '../db/index.mjs'

// 全局表：auth_session 由不可猜的 id 定位，tenant_id 只做记录，不参与鉴权
const COLS = 'id, user_id, tenant_id, expires_at, ip, ua, created_at'

/** @param {any} ctx @param {string} id @param {Date} now */
export const byId = (ctx, id, now) =>
  one(ctx, `SELECT ${COLS} FROM auth_session WHERE id = $1 AND expires_at > $2`, [id, now])

/**
 * @param {any} ctx
 * @param {{ id: string, userId: string, tenantId: string | null, expiresAt: Date, ip: string | null, ua: string | null, createdAt: Date }} s
 */
export const insert = (ctx, s) =>
  exec(
    ctx,
    `INSERT INTO auth_session (id, user_id, tenant_id, expires_at, ip, ua, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [s.id, s.userId, s.tenantId, s.expiresAt, s.ip, s.ua, s.createdAt],
  )

/** @param {any} ctx @param {string} id */
export const remove = (ctx, id) => exec(ctx, `DELETE FROM auth_session WHERE id = $1`, [id])

/**
 * 登录时顺手清理过期会话，省掉定时任务
 * @param {any} ctx
 * @param {Date} now
 */
export const purgeExpired = (ctx, now) => exec(ctx, `DELETE FROM auth_session WHERE expires_at <= $1`, [now])
