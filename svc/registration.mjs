import { randomUUID } from 'node:crypto'
import { HttpError, errors } from '../http/errors.mjs'
import * as captcha from '../auth/captcha.mjs'
import { hashPassword } from '../auth/password.mjs'
import { withTx } from '../db/index.mjs'
import * as audit from '../store/audit.mjs'
import * as invites from '../store/invite.mjs'
import * as loginAttempts from '../store/login.mjs'
import * as membership from '../store/membership.mjs'
import * as users from '../store/user.mjs'
import * as roles from '../store/role.mjs'
import * as tenants from '../store/tenant.mjs'
import * as settings from './settings.mjs'
import * as tenantSvc from './tenant.mjs'

const MIN_PASSWORD = 8
const REG_LIMIT = 10
const REG_WINDOW_MS = 60 * 60 * 1000

/** `*.gov.cn` / `acme.com` 形式的白名单；空 = 不限制 */
function domainAllowed(/** @type {string} */ email, /** @type {string} */ whitelist) {
  const list = whitelist.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!list.length) return true
  const domain = email.split('@')[1] ?? ''
  return list.some((p) =>
    p.startsWith('*.') ? domain === p.slice(2) || domain.endsWith(p.slice(1)) : domain === p,
  )
}

/**
 * 唯一判定入口（DESIGN §4.6）。新增模式只加一个分支，handler 不动。
 * @param {any} ctx
 * @param {{ email: string, slug?: string, inviteCode?: string }} input
 */
export async function canRegister(ctx, input) {
  const mode = await settings.get(ctx, 'registration.mode')
  if (mode === 'closed') return { ok: false, reason: 'registration_closed' }

  if (mode === 'invite') {
    // 邀请码本身就是凭证，不再要人机校验
    if (!input.slug || !input.inviteCode) return { ok: false, reason: 'invite_required' }
    return { ok: true, nextStep: 'join', captcha: false }
  }

  if (!domainAllowed(input.email, await settings.get(ctx, 'registration.email_domain_whitelist'))) {
    return { ok: false, reason: 'email_domain_not_allowed' }
  }
  if ((await settings.get(ctx, 'registration.require_admin_approval')) === 'true') {
    return { ok: true, nextStep: 'admin_approve', captcha: await captchaNeeded(ctx) }
  }
  return { ok: true, nextStep: 'create_tenant', captcha: await captchaNeeded(ctx) }
}

/** @param {any} ctx */
const captchaNeeded = async (ctx) => (await settings.get(ctx, 'registration.captcha')) !== 'none'

/**
 * 邮箱本地部分 → 合法 slug，撞了就加随机后缀
 * @param {any} ctx
 * @param {string} email
 * @param {string | undefined} wanted
 */
async function pickSlug(ctx, email, wanted) {
  const base = (wanted || email.split('@')[0] || 'company')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 40) || 'company'
  if (!(await tenants.bySlug(ctx, base))) return base
  for (let i = 0; i < 5; i++) {
    const s = `${base}-${randomUUID().slice(0, 4)}`
    if (!(await tenants.bySlug(ctx, s))) return s
  }
  throw new HttpError(errors.conflict, { reason: 'slug 无法分配' })
}

/**
 * 注册。canRegister 决策 → 校验人机 → 按 nextStep 执行。
 * @param {any} ctx
 * @param {{ email: string, password: string, displayName?: string, slug?: string, inviteCode?: string, captchaToken?: string, captchaAnswer?: string }} input
 * @returns {Promise<{ userId: string, tenantSlug: string | null, pending: boolean }>}
 */
export async function register(ctx, input) {
  const email = String(input.email ?? '').trim().toLowerCase()
  const password = String(input.password ?? '')
  if (!email.includes('@')) throw new HttpError(errors.badRequest, { reason: '邮箱格式不对' })
  if (password.length < MIN_PASSWORD) throw new HttpError(errors.badRequest, { reason: `密码至少 ${MIN_PASSWORD} 位` })

  const ip = ctx.req.socket.remoteAddress ?? null
  const recent = ip
    ? await loginAttempts.count(ctx, { ip, kind: 'register', since: new Date(Date.now() - REG_WINDOW_MS) })
    : 0
  if (recent >= REG_LIMIT) throw new HttpError(errors.tooManyRequests, { reason: '注册过于频繁' })

  const decision = await canRegister(ctx, { email, slug: input.slug, inviteCode: input.inviteCode })
  if (!decision.ok) throw new HttpError(errors.forbidden, { reason: decision.reason })

  if (decision.captcha && !captcha.verify(input.captchaToken, input.captchaAnswer)) {
    throw new HttpError(errors.badRequest, { reason: '人机校验未通过' })
  }

  // 已注册邮箱不重复建号（避免把别人的账号顶掉）
  if (await users.byEmail(ctx, email)) throw new HttpError(errors.conflict, { reason: '该邮箱已注册' })

  const now = new Date()
  const displayName = String(input.displayName ?? '').trim().slice(0, 64) || email.split('@')[0]

  await loginAttempts.record(ctx, {
    id: randomUUID(),
    kind: 'register',
    ident: email,
    ip,
    ok: true,
    at: now,
  })

  if (decision.nextStep === 'admin_approve') {
    await createUser(ctx, { email, password, displayName, status: 'pending', now })
    return { userId: '', tenantSlug: null, pending: true }
  }

  if (decision.nextStep === 'join') {
    const t = await tenants.bySlug(ctx, String(input.slug))
    if (!t || t.status !== 'active') throw new HttpError(errors.badRequest, { reason: 'invite_invalid' })
    const tctx = { ...ctx, tenantId: t.id }
    const inv = await invites.byCode(tctx, String(input.inviteCode))
    const expired = inv?.expires_at ? new Date(inv.expires_at) <= now : false
    if (!inv || inv.used_at || expired || inv.email !== email) {
      throw new HttpError(errors.badRequest, { reason: 'invite_invalid' })
    }

    const userId = randomUUID()
    const { hash, salt } = await hashPassword(password)
    await withTx(ctx, async (tx) => {
      await users.insert(tx, {
        id: userId,
        email,
        pwdHash: hash,
        pwdSalt: salt,
        displayName,
        status: 'active',
        createdAt: now,
      })
      const inTenant = { ...tx, tenantId: t.id }
      await membership.upsert(inTenant, {
        tenantId: t.id,
        userId,
        roleId: inv.role_id,
        status: 'active',
        joinedAt: now,
      })
      await invites.markUsed(inTenant, inv.code, now)
      await audit.insert(inTenant, {
        id: randomUUID(),
        module: 'member',
        action: 'join_by_invite',
        whoId: userId,
        refType: 'org_membership',
        refId: userId,
        before: null,
        after: { email, roleId: inv.role_id },
        traceId: ctx.requestId ?? '',
        at: now,
      })
    })
    return { userId, tenantSlug: t.slug, pending: false }
  }

  // create_tenant：复用建租户（含角色、审计），租户名按模板
  const template = await settings.get(ctx, 'registration.tenant_name_template')
  const slug = await pickSlug(ctx, email, input.slug)
  const out = await tenantSvc.createTenant(ctx, {
    slug,
    name: template.replace('{user}', displayName).slice(0, 64),
    email,
    password,
    displayName,
  })
  return { userId: out.userId, tenantSlug: out.slug, pending: false }
}

/**
 * 待管理员放行的用户（M0 无管理后台，走 cmd/user.mjs approve）
 * @param {any} ctx
 * @param {{ email: string, password: string, displayName: string, status: string, now: Date }} u
 */
async function createUser(ctx, u) {
  const { hash, salt } = await hashPassword(u.password)
  await users.insert(ctx, {
    id: randomUUID(),
    email: u.email,
    pwdHash: hash,
    pwdSalt: salt,
    displayName: u.displayName,
    status: u.status,
    createdAt: u.now,
  })
}

/**
 * 生成邀请（owner / member:manage）。M0 不发信：链接由人手工转（通知中心在 M2）。
 * @param {any} ctx
 * @param {{ email: string, roleCode?: string, days?: number }} input
 */
export async function createInvite(ctx, input) {
  const email = String(input.email ?? '').trim().toLowerCase()
  if (!email.includes('@')) throw new HttpError(errors.badRequest, { reason: '邮箱格式不对' })
  const roleCode = input.roleCode ?? 'member'
  const role = await roles.byCode(ctx, roleCode)
  if (!role) throw new HttpError(errors.badRequest, { reason: `无此角色 ${roleCode}` })

  const now = new Date()
  const days = Math.min(Math.max(Number(input.days ?? 7), 1), 30)
  const code = randomUUID().replace(/-/g, '').slice(0, 32)
  await invites.insert(ctx, {
    tenantId: ctx.tenantId,
    id: randomUUID(),
    email,
    code,
    roleId: role.id,
    expiresAt: new Date(now.getTime() + days * 86400_000),
    createdBy: ctx.userId,
    createdAt: now,
  })
  return { code, email, roleCode, days, url: `/t/${ctx.tenant.slug}/join?code=${code}&email=${encodeURIComponent(email)}` }
}

/**
 * 邀请前先看看这个邮箱是否已经在本公司里
 * @param {any} ctx
 * @param {string} email
 */
export async function isMemberEmail(ctx, email) {
  const u = await users.byEmail(ctx, email)
  if (!u) return false
  return Boolean(await membership.find(ctx, u.id))
}
