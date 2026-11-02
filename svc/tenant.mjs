import { randomUUID } from 'node:crypto'
import { HttpError, errors } from '../http/errors.mjs'
import { ROLE_SCOPE } from '../auth/perm.mjs'
import { hashPassword } from '../auth/password.mjs'
import { withTx } from '../db/index.mjs'
import * as audit from '../store/audit.mjs'
import * as membership from '../store/membership.mjs'
import * as roles from '../store/role.mjs'
import * as tenants from '../store/tenant.mjs'
import * as users from '../store/user.mjs'

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

/** M0 只建两个角色：owner（全部）与 member（本人数据） */
const SEED_ROLES = ['owner', 'member']

/**
 * 建租户 + 创始人 + 角色 + 成员关系，全程一个事务。
 * ctx 为全局上下文（tenantId 为空），事务内再派生带 tenantId 的子上下文。
 * @param {any} ctx
 * @param {{ slug: string, name: string, email: string, password: string, displayName?: string }} input
 */
export async function createTenant(ctx, input) {
  const slug = String(input.slug ?? '').trim().toLowerCase()
  const name = String(input.name ?? '').trim()
  const email = String(input.email ?? '').trim().toLowerCase()
  if (!SLUG.test(slug)) throw new HttpError(errors.badRequest, { reason: 'slug 只能是小写字母数字和连字符' })
  if (name.length < 1 || name.length > 64) throw new HttpError(errors.badRequest, { reason: '公司名长度 1-64' })
  if (!email.includes('@')) throw new HttpError(errors.badRequest, { reason: '邮箱格式不对' })
  if (String(input.password ?? '').length < 8) throw new HttpError(errors.badRequest, { reason: '密码至少 8 位' })

  if (await tenants.bySlug(ctx, slug)) throw new HttpError(errors.conflict, { reason: `slug ${slug} 已被占用` })
  if (await users.byEmail(ctx, email)) throw new HttpError(errors.conflict, { reason: `邮箱 ${email} 已注册` })

  const now = new Date()
  const tenantId = randomUUID()
  const userId = randomUUID()
  const { hash, salt } = await hashPassword(input.password)

  await withTx(ctx, async (tx) => {
    await tenants.insert(tx, {
      id: tenantId,
      slug,
      name,
      status: 'active',
      plan: 'free',
      joinPolicy: 'invite_only',
      createdAt: now,
    })
    await users.insert(tx, {
      id: userId,
      email,
      pwdHash: hash,
      pwdSalt: salt,
      displayName: String(input.displayName ?? email.split('@')[0]).slice(0, 64),
      status: 'active',
      createdAt: now,
    })

    // 之后的语句都在租户内，$t 才有值
    const inTenant = { ...tx, tenantId }
    const roleIds = new Map()
    for (const code of SEED_ROLES) {
      const id = randomUUID()
      roleIds.set(code, id)
      await roles.insert(inTenant, { tenantId, id, code, name: code, scope: ROLE_SCOPE[code], createdAt: now })
    }
    await membership.upsert(inTenant, {
      tenantId,
      userId,
      roleId: roleIds.get('owner'),
      status: 'active',
      joinedAt: now,
    })
    await audit.insert(inTenant, {
      id: randomUUID(),
      module: 'tenant',
      action: 'create',
      whoId: ctx.userId ?? userId,
      refType: 'org_tenant',
      refId: tenantId,
      before: null,
      after: { slug, name, ownerEmail: email },
      traceId: ctx.requestId ?? 'cli',
      at: now,
    })
  })

  return { tenantId, slug, userId, email }
}
