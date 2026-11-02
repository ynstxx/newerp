import { exec, one, q } from '../db/index.mjs'

// 全局表：无 tenant_id，允许不带 $t
const COLS = 'id, email, pwd_hash, pwd_salt, display_name, status, created_at'

/** @param {any} ctx @param {string} email */
export const byEmail = (ctx, email) => one(ctx, `SELECT ${COLS} FROM auth_user WHERE email = $1`, [email])

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM auth_user WHERE id = $1`, [id])

/** @param {any} ctx */
export const pending = (ctx) =>
  q(ctx, `SELECT id, email, display_name, created_at FROM auth_user WHERE status = 'pending' ORDER BY created_at`, [])

/** @param {any} ctx @param {string} email @param {string} status */
export const setStatus = (ctx, email, status) =>
  exec(ctx, `UPDATE auth_user SET status = $1 WHERE email = $2`, [status, email])

/**
 * @param {any} ctx
 * @param {{ id: string, email: string, pwdHash: string, pwdSalt: string, displayName: string, status: string, createdAt: Date }} u
 */
export const insert = (ctx, u) =>
  exec(
    ctx,
    `INSERT INTO auth_user (id, email, pwd_hash, pwd_salt, display_name, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [u.id, u.email, u.pwdHash, u.pwdSalt, u.displayName, u.status, u.createdAt],
  )
