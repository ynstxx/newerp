import { needUser } from '../auth/perm.mjs'
import { readJson, only } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import * as tenantSvc from '../svc/tenant.mjs'
import * as auth from '../svc/auth.mjs'
import * as tenants from '../store/tenant.mjs'
import * as users from '../store/user.mjs'

/** @type {import('../http/router.mjs').Handler} */
export async function login(ctx) {
  const body = only(await readJson(ctx), ['email', 'password'])
  const email = String(body.email ?? '').trim().toLowerCase()
  const password = String(body.password ?? '')
  if (!email.includes('@') || !password) throw new HttpError(errors.badRequest, { reason: '邮箱和密码都要填' })
  const user = await auth.login(ctx, email, password)
  sendJson(ctx.res, 200, { user })
}

/** @type {import('../http/router.mjs').Handler} */
export async function logout(ctx) {
  await auth.logout(ctx)
  sendJson(ctx.res, 200, { ok: true })
}

/**
 * 同一份 handler 服务两个作用域：
 *   /api/me             → 用户 + 我加入的公司列表
 *   /t/{slug}/api/me    → 用户 + 当前公司 + 角色 + 权限点
 * @type {import('../http/router.mjs').Handler}
 */
export async function me(ctx) {
  needUser(ctx)
  const user = await users.byId(ctx, ctx.userId)
  if (!user) throw new HttpError(errors.unauthorized)
  /** @type {Record<string, unknown>} */
  const out = { user: auth.publicUser(user) }
  if (ctx.tenant) {
    out.tenant = ctx.tenant
    out.role = ctx.role
    out.perms = [...ctx.perms]
  } else {
    out.tenants = (await tenants.listByUser(ctx, ctx.userId)).map((t) => ({
      slug: t.slug,
      name: t.name,
      role: t.role_code,
    }))
  }
  sendJson(ctx.res, 200, out)
}

/**
 * 建公司。M0 只有 CLI 用得到它，这里只暴露给平台管理员之后（M0 无平台管理员，故注册成函数不注册成路由）。
 * 保留导出是为了 S4 的注册流程直接复用同一个函数。
 * @type {(ctx: any, input: any) => Promise<unknown>}
 */
export const createTenant = tenantSvc.createTenant
