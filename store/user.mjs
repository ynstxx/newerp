import { exec, one } from '../db/index.mjs'

// 全局表：无 tenant_id，允许不带 $t
const COLS = 'id, email, pwd_hash, pwd_salt, display_name, status, created_at'

/** @param {any} ctx @param {string} email */
export const byEmail = (ctx, email) => one(ctx, `SELECT ${COLS} FROM auth_user WHERE email = $1`, [email])

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM auth_user WHERE id = $1`, [id])

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
