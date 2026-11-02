import { one, q } from '../db/index.mjs'

// 审批人解析要用的组织数据。单表查询，避免 $t 在 JOIN 里展开成歧义列名。

/** @param {any} ctx @param {string} deptId */
export const deptById = (ctx, deptId) =>
  one(ctx, `SELECT id, parent_id, name, path, manager_user_id FROM org_dept WHERE $t AND id = $1`, [deptId])

/**
 * 用户所在部门（一人多部门时取 path 最靠前的那个）
 * @param {any} ctx @param {string} userId
 */
export const deptOfUser = (ctx, userId) =>
  one(
    ctx,
    `SELECT d.id, d.parent_id, d.name, d.path, d.manager_user_id
       FROM (SELECT dept_id FROM org_dept_member WHERE $t AND user_id = $1) m
       JOIN org_dept d ON d.tenant_id = $2 AND d.id = m.dept_id
      ORDER BY d.path ASC
      LIMIT 1`,
    [userId],
  )

/**
 * 该角色下的有效成员（role 型审批人解析成具体人）
 * @param {any} ctx @param {string} roleId
 */
export const memberIdsByRoleId = (ctx, roleId) =>
  q(
    ctx,
    `SELECT user_id FROM org_membership WHERE $t AND role_id = $1 AND status = 'active' ORDER BY user_id ASC`,
    [roleId],
  )

/** @param {any} ctx @param {string} userId */
export const activeMember = (ctx, userId) =>
  one(ctx, `SELECT 1 AS ok FROM org_membership WHERE $t AND user_id = $1 AND status = 'active'`, [userId])

/**
 * 部门成员（测试/后续组织模块写入用；本域只读 org_dept_member）
 * @param {any} ctx @param {string} deptId
 */
export const deptMembers = (ctx, deptId) =>
  q(ctx, `SELECT user_id FROM org_dept_member WHERE $t AND dept_id = $1 ORDER BY user_id ASC`, [deptId])
