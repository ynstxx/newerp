import { randomUUID } from 'node:crypto'
import { config } from '../config.mjs'
import { parseCookies, setCookie } from '../http/cookie.mjs'
import * as store from '../store/session.mjs'

export const COOKIE = 'sid'
const TTL_MS = 7 * 24 * 3600 * 1000

/**
 * 读取会话并挂到 ctx。无 cookie 时一次查询都不发。
 * @param {any} ctx
 */
export async function load(ctx) {
  const sid = parseCookies(ctx.req.headers.cookie)[COOKIE]
  if (!sid) return
  const s = await store.byId(ctx, sid, new Date())
  if (!s) return
  ctx.sessionId = s.id
  ctx.userId = s.user_id
}

/**
 * @param {any} ctx
 * @param {string} userId
 * @param {string | null} [tenantId]
 */
export async function create(ctx, userId, tenantId = null) {
  const now = new Date()
  const id = randomUUID()
  await store.insert(ctx, {
    id,
    userId,
    tenantId,
    expiresAt: new Date(now.getTime() + TTL_MS),
    ip: ctx.req.socket.remoteAddress ?? null,
    ua: String(ctx.req.headers['user-agent'] ?? '').slice(0, 500) || null,
    createdAt: now,
  })
  setCookie(ctx.res, COOKIE, id, { maxAge: Math.floor(TTL_MS / 1000), secure: config.env === 'production' })
  ctx.sessionId = id
  ctx.userId = userId
}

/** @param {any} ctx */
export async function destroy(ctx) {
  if (ctx.sessionId) await store.remove(ctx, ctx.sessionId)
  setCookie(ctx.res, COOKIE, '', { maxAge: 0, secure: config.env === 'production' })
  ctx.sessionId = undefined
  ctx.userId = null
}

/** @param {any} ctx */
export const purgeExpired = (ctx) => store.purgeExpired(ctx, new Date())
