import { one, q } from '../db/index.mjs'

// 工作台聚合读：只读、无事务、每条 SQL 必带 $t。

/** @param {any} ctx */
export const countProjects = (ctx) => one(ctx, `SELECT COUNT(*) AS n FROM project WHERE $t`, [])

/** @param {any} ctx */
export const countOpportunities = (ctx) => one(ctx, `SELECT COUNT(*) AS n FROM opportunity WHERE $t`, [])

/** @param {any} ctx */
export const countQuotations = (ctx) => one(ctx, `SELECT COUNT(*) AS n FROM quotation WHERE $t`, [])

/** @param {any} ctx */
export const countContracts = (ctx) => one(ctx, `SELECT COUNT(*) AS n FROM contract WHERE $t`, [])

/**
 * 合同总额。取 contract.amount —— project.contract_amt 在 M1 没有任何写入方（合同切片只改状态），
 * 对项目头求和会永远返回 0，看板就成了假数字。
 * @param {any} ctx
 */
export const sumContractAmount = (ctx) =>
  one(ctx, `SELECT COALESCE(SUM(amount), 0) AS amt FROM contract WHERE $t`, [])

/**
 * 最近状态流水。流水表是驱动表，项目名走投影内连接 ——
 * $t 只落在内层（单表，列名不歧义），外层用参数 $2 对齐租户。
 * @param {any} ctx @param {number} limit
 */
export const recentStages = (ctx, limit) =>
  q(
    ctx,
    `SELECT s.project_id, s.from_status, s.to_status, s.at, p.code AS project_code, p.name AS project_name
       FROM (SELECT id, project_id, from_status, to_status, at
               FROM project_stage_log WHERE $t ORDER BY at DESC, id DESC LIMIT $1) s
       JOIN project p ON p.tenant_id = $2 AND p.id = s.project_id
      ORDER BY s.at DESC, s.id DESC`,
    [limit],
  )

/** 待签约（status=quoting）的项目，按最近更新排序 @param {any} ctx @param {number} limit */
export const quotingProjects = (ctx, limit) =>
  q(
    ctx,
    `SELECT id, code, name, status, updated_at FROM project
      WHERE $t AND status = $1 ORDER BY updated_at DESC, id DESC LIMIT $2`,
    ['quoting', limit],
  )
