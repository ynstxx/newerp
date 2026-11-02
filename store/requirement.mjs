import { exec, one, q } from '../db/index.mjs'
import { cursorClause } from '../http/page.mjs'

// 租户表：所有语句必带 $t
const COLS = 'id, project_id, title, content, status, confirmed_by, confirmed_at, created_at, updated_at, version'

/** @param {any} ctx @param {string} id */
export const byId = (ctx, id) => one(ctx, `SELECT ${COLS} FROM requirement WHERE $t AND id = $1`, [id])

/**
 * 列表。过滤与排序都来自白名单常量，用户输入只进参数。
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, projectId?: string, status?: string }} f
 */
export function list(ctx, f) {
  /** @type {string[]} */
  const conds = []
  /** @type {unknown[]} */
  let args = []

  if (f.projectId) {
    args.push(f.projectId)
    conds.push(`project_id = $${args.length}`)
  }
  if (f.status) {
    args.push(f.status)
    conds.push(`status = $${args.length}`)
  }
  const cur = cursorClause(f.cursor, args, f.order)
  if (cur.sql) conds.push(cur.sql.replace(/^ AND /, ''))
  args = cur.args

  args.push(f.limit + 1)
  const sql =
    `SELECT ${COLS} FROM requirement WHERE $t${conds.length ? ` AND ${conds.join(' AND ')}` : ''}` +
    ` ORDER BY created_at ${f.order}, id ${f.order} LIMIT $${args.length}`
  return q(ctx, sql, args)
}

/**
 * @param {any} ctx
 * @param {{ id: string, projectId: string, title: string, content: string | null, status: string, now: Date }} p
 */
export const insert = (ctx, p) =>
  exec(
    ctx,
    `INSERT INTO requirement (tenant_id, id, project_id, title, content, status, confirmed_by, confirmed_at, created_at, updated_at, version)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, $7, 1)`,
    [ctx.tenantId, p.id, p.projectId, p.title, p.content, p.status, p.now],
  )

/**
 * 乐观锁：version 必须匹配才改，改完自增。0 行 → 上层按 409 处理。
 * @param {any} ctx
 * @param {{ id: string, title: string, content: string | null, expectedVersion: number, now: Date }} p
 */
export const update = (ctx, p) =>
  exec(
    ctx,
    `UPDATE requirement
        SET title = $1, content = $2, updated_at = $3, version = version + 1
      WHERE $t AND id = $4 AND version = $5`,
    [p.title, p.content, p.now, p.id, p.expectedVersion],
  )

/**
 * 状态变更：带上 from 状态做并发兜底，0 行由 svc 转 409。
 * @param {any} ctx
 * @param {{ id: string, status: string, from: string, userId: string | null, now: Date }} p
 */
export const confirm = (ctx, p) =>
  exec(
    ctx,
    `UPDATE requirement
        SET status = $1, confirmed_by = $2, confirmed_at = $3, updated_at = $3
      WHERE $t AND id = $4 AND status = $5`,
    [p.status, p.userId, p.now, p.id, p.from],
  )

// 跨切片只读：项目是否存在（不 import A 切片的 store）
/** @param {any} ctx @param {string} projectId */
export const projectExists = (ctx, projectId) => one(ctx, `SELECT id FROM project WHERE $t AND id = $1`, [projectId])
