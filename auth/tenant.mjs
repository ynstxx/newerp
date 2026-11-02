import { HttpError, errors } from '../http/errors.mjs'
import { permsOf } from './perm.mjs'
import * as roles from '../store/role.mjs'
import * as membership from '../store/membership.mjs'
import * as tenants from '../store/tenant.mjs'

const PREFIX = /^\/t\/([a-z0-9][a-z0-9-]{0,62})\/(.*)$/

/**
 * 租户解析中间件：/t/{slug}/… → ctx.tenantId + ctx.tenant + ctx.role + ctx.perms，
 * 并把 ctx.path 收敛到租户内的路径（/api/…），路由表因此只注册一份。
 *
 * 每请求都查 membership —— 成员可以被踢掉，会话不能替它背书。
 * 非成员一律 404（不是 403，403 会泄漏"这个公司存在"）。
 * @type {import('../http/middleware.mjs').Middleware}
 */
export async function tenant(ctx, next) {
  const m = PREFIX.exec(ctx.url.pathname)
  if (!m) return next()

  const [, slug, rest] = m
  ctx.path = `/${rest}`

  const t = await tenants.bySlug(ctx, slug)
  if (!t || t.status !== 'active') throw new HttpError(errors.notFound)
  if (!ctx.userId) throw new HttpError(errors.unauthorized)

  // 先把 tenantId 挂上，后面 store 的 $t 才有值
  ctx.tenantId = t.id
  const mem = await membership.find(ctx, ctx.userId)
  if (!mem || mem.status !== 'active') throw new HttpError(errors.notFound)

  const role = mem.role_id ? await roles.byId(ctx, mem.role_id) : null
  ctx.tenant = { id: t.id, slug: t.slug, name: t.name, plan: t.plan }
  ctx.role = role ? { code: role.code, scope: role.scope } : { code: 'member', scope: 'own' }
  ctx.perms = permsOf(ctx.role.code)

  await next()
}
