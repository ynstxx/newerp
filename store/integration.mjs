import { exec, one, q } from '../db/index.mjs'

// ── integration_conn ────────────────────────────────────────────────────────
const CONN = 'tenant_id, id, provider, corp_id, agent_id, secrets, enabled, last_sync_at, version'

/** @param {any} ctx */
export const listConns = (ctx) => q(ctx, `SELECT ${CONN} FROM integration_conn WHERE $t ORDER BY provider`, [])

/** @param {any} ctx @param {string} id */
export const connById = (ctx, id) => one(ctx, `SELECT ${CONN} FROM integration_conn WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} provider */
export const connByProvider = (ctx, provider) =>
  one(ctx, `SELECT ${CONN} FROM integration_conn WHERE $t AND provider = $1`, [provider])

/**
 * @param {any} ctx
 * @param {{ id: string, provider: string, corpId: string | null, agentId: string | null, secrets: string | null, enabled: boolean, lastSyncAt: Date | null, version: number }} c
 */
export const insertConn = (ctx, c) =>
  exec(
    ctx,
    `INSERT INTO integration_conn (tenant_id, id, provider, corp_id, agent_id, secrets, enabled, last_sync_at, version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      ctx.tenantId,
      c.id,
      c.provider,
      c.corpId,
      c.agentId,
      // jsonb 列：裸 base64 不是合法 JSON，必须作为 JSON 字符串写入
      c.secrets === null ? null : JSON.stringify(c.secrets),
      c.enabled,
      c.lastSyncAt,
      c.version,
    ],
  )

/**
 * 乐观锁：版本没变才更新。0 行由 svc 转 409。
 * @param {any} ctx
 * @param {{ id: string, expectedVersion: number, corpId: string | null, agentId: string | null, secrets: string | null, enabled: boolean }} c
 */
export const updateConn = (ctx, c) =>
  exec(
    ctx,
    `UPDATE integration_conn
        SET corp_id = $1, agent_id = $2, secrets = $3, enabled = $4, version = version + 1
      WHERE $t AND id = $5 AND version = $6`,
    [c.corpId, c.agentId, c.secrets === null ? null : JSON.stringify(c.secrets), c.enabled, c.id, c.expectedVersion],
  )

/** @param {any} ctx @param {string} id @param {Date} at */
export const touchLastSync = (ctx, id, at) =>
  exec(ctx, `UPDATE integration_conn SET last_sync_at = $1, version = version + 1 WHERE $t AND id = $2`, [at, id])

// ── integration_map ─────────────────────────────────────────────────────────
const MAP = 'tenant_id, id, provider, external_type, external_id, local_id, synced_at'

/**
 * @param {any} ctx
 * @param {{ provider: string, externalType: string, externalId: string }} k
 */
export const mapByKey = (ctx, k) =>
  one(
    ctx,
    `SELECT ${MAP} FROM integration_map
      WHERE $t AND provider = $1 AND external_type = $2 AND external_id = $3`,
    [k.provider, k.externalType, k.externalId],
  )

/** @param {any} ctx @param {string} provider @param {string} externalType */
export const mapsOf = (ctx, provider, externalType) =>
  q(
    ctx,
    `SELECT ${MAP} FROM integration_map
      WHERE $t AND provider = $1 AND external_type = $2
      ORDER BY external_id`,
    [provider, externalType],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, provider: string, externalType: string, externalId: string, localId: string, syncedAt: Date }} m
 */
export const insertMap = (ctx, m) =>
  exec(
    ctx,
    `INSERT INTO integration_map (tenant_id, id, provider, external_type, external_id, local_id, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.tenantId, m.id, m.provider, m.externalType, m.externalId, m.localId, m.syncedAt],
  )

/** @param {any} ctx @param {string} id @param {Date} at */
export const touchMap = (ctx, id, at) =>
  exec(ctx, `UPDATE integration_map SET synced_at = $1 WHERE $t AND id = $2`, [at, id])

/**
 * 映射指向的本地用户意外消失时重新挂靠（正常数据不会走到这里）
 * @param {any} ctx @param {string} id @param {string} localId @param {Date} at
 */
export const remap = (ctx, id, localId, at) =>
  exec(ctx, `UPDATE integration_map SET local_id = $1, synced_at = $2 WHERE $t AND id = $3`, [localId, at, id])

// ── 同步写入 local 表（auth_user 是全局表；org_membership 带 $t）──────────────

/** @param {any} ctx @param {string} id */
export const userById = (ctx, id) =>
  one(ctx, `SELECT id, email, display_name, status FROM auth_user WHERE id = $1`, [id])

/** @param {any} ctx @param {string} email */
export const userByEmail = (ctx, email) =>
  one(ctx, `SELECT id, email, display_name, status FROM auth_user WHERE email = $1`, [email])

/** @param {any} ctx @param {string} id @param {string} displayName */
export const updateUserName = (ctx, id, displayName) =>
  exec(ctx, `UPDATE auth_user SET display_name = $1 WHERE id = $2`, [displayName, id])

/** @param {any} ctx @param {string} id @param {string} email */
export const updateUserEmail = (ctx, id, email) =>
  exec(ctx, `UPDATE auth_user SET email = $1 WHERE id = $2`, [email, id])

/** @param {any} ctx @param {string} userId */
export const membershipByUser = (ctx, userId) =>
  one(ctx, `SELECT user_id, role_id, status FROM org_membership WHERE $t AND user_id = $1`, [userId])

/**
 * 新成员的 role_id 留空（按 member 处理）；已有角色绝不在同步里覆盖。
 * @param {any} ctx
 * @param {{ userId: string, roleId: string | null, status: string, joinedAt: Date }} m
 */
export const insertMembership = (ctx, m) =>
  exec(
    ctx,
    `INSERT INTO org_membership (tenant_id, user_id, role_id, status, joined_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [ctx.tenantId, m.userId, m.roleId, m.status, m.joinedAt],
  )

/** @param {any} ctx @param {string} userId @param {string} status */
export const setMembershipStatus = (ctx, userId, status) =>
  exec(ctx, `UPDATE org_membership SET status = $1 WHERE $t AND user_id = $2`, [status, userId])

// ── integration_sync_log ────────────────────────────────────────────────────
const LOG = 'tenant_id, id, provider, action, counts, error, at'

/**
 * @param {any} ctx
 * @param {{ id: string, provider: string, action: string, counts: unknown, error: string | null, at: Date }} l
 */
export const insertLog = (ctx, l) =>
  exec(
    ctx,
    `INSERT INTO integration_sync_log (tenant_id, id, provider, action, counts, error, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ctx.tenantId, l.id, l.provider, l.action, l.counts === null ? null : JSON.stringify(l.counts), l.error, l.at],
  )

/**
 * @param {any} ctx @param {string} provider @param {number} limit
 */
export const listLogs = (ctx, provider, limit) =>
  q(
    ctx,
    `SELECT ${LOG} FROM integration_sync_log
      WHERE $t AND provider = $1
      ORDER BY at DESC
      LIMIT $2`,
    [provider, Math.max(1, Math.min(100, Number(limit) || 20))],
  )
