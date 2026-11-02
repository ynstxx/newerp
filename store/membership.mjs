import { exec, one, q } from '../db/index.mjs'

// 租户表：所有语句必带 $t
const COLS = 'tenant_id, user_id, role_id, status, joined_at'

/**
 * 这个用户是不是本公司的有效成员。
 * owner_id / pm_user_id 指向全局表 auth_user，复合外键保护不到，
 * 只能在这里挡：不然能把别租户的用户 id 写进来并在界面上回显。
 * @param {any} ctx @param {string} userId
 */
export const memberExists = (ctx, userId) =>
  one(
    ctx,
    `SELECT 1 AS ok FROM org_membership WHERE $t AND user_id = $1 AND status = 'active'`,
    [userId],
  )

/**
 * 本公司成员清单（含姓名与角色）。auth_user 是全局表，用 user_id 关联；
 * 租户谓词由 org_membership 的 $t 保证。
 * @param {any} ctx
 */
export const listMembers = (ctx) =>
  q(
    ctx,
    // 只 JOIN 全局表 auth_user：$t 展开成裸 tenant_id，JOIN 第二张带 tenant_id 的表会歧义
    `SELECT m.user_id, m.status, u.email, u.display_name
       FROM org_membership m
       JOIN auth_user u ON u.id = m.user_id
      WHERE $t AND m.status = 'active'
      ORDER BY u.display_name`,
    [],
  )

/** @param {any} ctx @param {string} userId */
export const find = (ctx, userId) =>
  one(ctx, `SELECT ${COLS} FROM org_membership WHERE $t AND user_id = $1`, [userId])

/**
 * @param {any} ctx
 * @param {{ tenantId: string, userId: string, roleId: string, status: string, joinedAt: Date }} m
 */
export const upsert = (ctx, m) =>
  exec(
    ctx,
    `INSERT INTO org_membership (tenant_id, user_id, role_id, status, joined_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [m.tenantId, m.userId, m.roleId, m.status, m.joinedAt],
  )
