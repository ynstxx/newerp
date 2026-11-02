import { exec, one } from '../db/index.mjs'

// 租户表：auth_role 带 tenant_id
const COLS = 'tenant_id, id, code, name, scope'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM auth_role WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} code */
export const byCode = (ctx, code) => one(ctx, `SELECT ${COLS} FROM auth_role WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ tenantId: string, id: string, code: string, name: string, scope: string, createdAt: Date }} r
 */
export const insert = (ctx, r) =>
  exec(
    ctx,
    `INSERT INTO auth_role (tenant_id, id, code, name, scope, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
    [r.tenantId, r.id, r.code, r.name, r.scope, r.createdAt],
  )
