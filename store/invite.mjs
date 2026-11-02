import { exec, one } from '../db/index.mjs'

// 租户表：邀请码按公司隔离，一码一人一邮箱
const COLS = 'tenant_id, id, email, code, role_id, expires_at, used_at, created_by, created_at'

/** @param {any} ctx @param {string} code */
export const byCode = (ctx, code) => one(ctx, `SELECT ${COLS} FROM tenant_invite WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ tenantId: string, id: string, email: string, code: string, roleId: string, expiresAt: Date | null, createdBy: string | null, createdAt: Date }} i
 */
export const insert = (ctx, i) =>
  exec(
    ctx,
    `INSERT INTO tenant_invite (tenant_id, id, email, code, role_id, expires_at, used_at, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
    [i.tenantId, i.id, i.email, i.code, i.roleId, i.expiresAt, i.createdBy, i.createdAt],
  )

/** @param {any} ctx @param {string} code @param {Date} at */
export const markUsed = (ctx, code, at) =>
  exec(ctx, `UPDATE tenant_invite SET used_at = $1 WHERE $t AND code = $2 AND used_at IS NULL`, [at, code])
