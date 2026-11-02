import { randomUUID } from 'node:crypto'
import { HttpError, errors } from '../http/errors.mjs'
import * as session from '../auth/session.mjs'
import { hashPassword, verifyPassword } from '../auth/password.mjs'
import * as loginAttempts from '../store/login.mjs'
import * as users from '../store/user.mjs'

const IDENT_WINDOW_MS = 15 * 60 * 1000
const IP_WINDOW_MS = 60 * 60 * 1000
const IDENT_LIMIT = 5
const IP_LIMIT = 20

// 用户不存在时也跑一次 scrypt，抹掉"邮箱是否注册"的耗时差
const DUMMY = { hash: '00'.repeat(64), salt: '00'.repeat(16) }

/** @param {any} u */
export const publicUser = (u) => ({ id: u.id, email: u.email, displayName: u.display_name })

/**
 * @param {any} ctx
 * @param {string} userName
 * @param {string} password
 */
export async function login(ctx, userName, password) {
  const now = Date.now()
  if ((await loginAttempts.countFailures(ctx, { ident: userName, since: new Date(now - IDENT_WINDOW_MS) })) >= IDENT_LIMIT) {
    throw new HttpError(errors.tooManyRequests, { reason: '账号失败次数过多' })
  }
  const ip = ctx.req.socket.remoteAddress ?? null
  if (ip && (await loginAttempts.countFailures(ctx, { ip, since: new Date(now - IP_WINDOW_MS) })) >= IP_LIMIT) {
    throw new HttpError(errors.tooManyRequests, { reason: 'IP 失败次数过多' })
  }

  const user = await users.byEmail(ctx, userName)
  const hash = user?.pwd_hash ?? DUMMY.hash
  const salt = user?.pwd_salt ?? DUMMY.salt
  const matched = await verifyPassword(password, hash, salt)
  const ok = Boolean(user) && user.status === 'active' && matched

  await loginAttempts.record(ctx, {
    id: randomUUID(),
    kind: 'password',
    ident: userName,
    ip,
    ok,
    at: new Date(),
  })
  if (!ok) throw new HttpError(errors.unauthorized, { reason: '邮箱或密码不正确' })

  await session.purgeExpired(ctx)
  await session.create(ctx, user.id)
  return publicUser(user)
}

/** @param {any} ctx */
export async function logout(ctx) {
  await session.destroy(ctx)
}
