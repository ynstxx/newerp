import * as captcha from '../auth/captcha.mjs'
import { need, PERM } from '../auth/perm.mjs'
import * as session from '../auth/session.mjs'
import { readJson, only } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import * as registration from '../svc/registration.mjs'
import * as settings from '../svc/settings.mjs'
import * as tenants from '../store/tenant.mjs'

/**
 * 前端据此渲染注册表单，不用把模式写死在界面里。
 * @type {import('../http/router.mjs').Handler}
 */
export async function registerInfo(ctx) {
  const mode = await settings.get(ctx, 'registration.mode')
  const slug = ctx.url.searchParams.get('slug') ?? ''
  const code = ctx.url.searchParams.get('code') ?? ''

  /** @type {Record<string, unknown>} */
  const out = {
    mode,
    captcha: 'none',
    requireAdminApproval: (await settings.get(ctx, 'registration.require_admin_approval')) === 'true',
    tenant: null,
  }

  if (mode === 'invite') {
    if (slug) {
      const t = await tenants.bySlug(ctx, slug)
      out.tenant = t && t.status === 'active' ? { slug: t.slug, name: t.name } : null
    }
    out.inviteCode = code ? 'present' : null
    return sendJson(ctx.res, 200, out)
  }

  const kind = await settings.get(ctx, 'registration.captcha')
  if (kind !== 'none') {
    out.captcha = kind
    out.challenge = captcha.issue()
  }
  sendJson(ctx.res, 200, out)
}

/** @type {import('../http/router.mjs').Handler} */
export async function register(ctx) {
  const body = only(await readJson(ctx), [
    'email',
    'password',
    'displayName',
    'slug',
    'inviteCode',
    'captchaToken',
    'captchaAnswer',
  ])
  const out = await registration.register(ctx, {
    email: String(body.email ?? ''),
    password: String(body.password ?? ''),
    displayName: body.displayName === undefined ? undefined : String(body.displayName),
    slug: body.slug === undefined ? undefined : String(body.slug),
    inviteCode: body.inviteCode === undefined ? undefined : String(body.inviteCode),
    captchaToken: body.captchaToken === undefined ? undefined : String(body.captchaToken),
    captchaAnswer: body.captchaAnswer === undefined ? undefined : String(body.captchaAnswer),
  })

  if (out.pending) {
    return sendJson(ctx.res, 202, { pending: true, message: '已提交，等待管理员放行' })
  }
  await session.create(ctx, out.userId, null)
  sendJson(ctx.res, 201, { tenant: out.tenantSlug ? { slug: out.tenantSlug } : null })
}

/** @type {import('../http/router.mjs').Handler} */
export async function createInvite(ctx) {
  need(ctx, PERM.memberManage)
  const body = only(await readJson(ctx), ['email', 'roleCode', 'days'])
  if (await registration.isMemberEmail(ctx, String(body.email ?? ''))) {
    throw new HttpError(errors.conflict, { reason: '该邮箱已是本公司成员' })
  }
  const invite = await registration.createInvite(ctx, {
    email: String(body.email ?? ''),
    roleCode: body.roleCode === undefined ? undefined : String(body.roleCode),
    days: body.days === undefined ? undefined : Number(body.days),
  })
  sendJson(ctx.res, 201, invite)
}
