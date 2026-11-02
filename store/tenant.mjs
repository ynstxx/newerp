import { exec, one, q } from '../db/index.mjs'

// 全局表：org_tenant 是租户本身，不带 tenant_id
const COLS = 'id, slug, name, status, plan, join_policy, created_at'

/** @param {any} ctx @param {string} slug */
export const bySlug = (ctx, slug) => one(ctx, `SELECT ${COLS} FROM org_tenant WHERE slug = $1`, [slug])

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM org_tenant WHERE id = $1`, [id])

/**
 * 用户所属的全部租户。表注释 tenant-free 是因为它故意跨租户（按已鉴权的 user_id 聚合），
 * 没有单一 tenant_id 可带 —— tenant_guard 测试认得这个标记。
 * @param {any} ctx @param {string} userId
 */
export const listByUser = (ctx, userId) =>
  q(
    ctx,
    `SELECT /* tenant-free */ t.id, t.slug, t.name, m.status AS member_status, r.code AS role_code
       FROM org_tenant t
       JOIN org_membership m ON m.tenant_id = t.id
       LEFT JOIN auth_role r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
      WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'
      ORDER BY t.created_at`,
    [userId],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, slug: string, name: string, status: string, plan: string, joinPolicy: string, createdAt: Date }} t
 */
export const insert = (ctx, t) =>
  exec(
    ctx,
    `INSERT INTO org_tenant (id, slug, name, status, plan, join_policy, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [t.id, t.slug, t.name, t.status, t.plan, t.joinPolicy, t.createdAt],
  )
