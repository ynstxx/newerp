import { exec, one, q } from '../db/index.mjs'

/**
 * 通知中心 store。无业务判断，只有 SQL。
 *
 * 注意 worker 的取任务语句不带 `$t`：那是跨租户的系统级查询（一轮取所有租户的待发任务），
 * 取出来之后才按 row.tenant_id 派生每行的租户上下文。其余语句一律 `$t`。
 */

export const CHANNEL_COLS = 'id, type, enabled, config, version, created_at, updated_at'
export const TEMPLATE_COLS = 'id, code, channel, lang, subject, body, version, created_at, updated_at'
export const OUTBOX_COLS =
  'id, channel, to_addr, template_code, vars, status, attempts, next_retry_at, error, dedupe_key, created_at'
export const INBOX_COLS = 'id, user_id, title, body, link, read_at, created_at'

/** json 列：PG 返回对象、老驱动可能返回字符串，统一成对象 */
export function parseJson(/** @type {unknown} */ v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    try {
      return JSON.parse(v)
    } catch {
      return null
    }
  }
  return v
}

/** 唯一键冲突：PG 23505 / MySQL 1062 —— 幂等去重靠它，不要冒成 500 */
export function isUniqueViolation(/** @type {any} */ err) {
  return err?.code === '23505' || err?.errno === 1062 || err?.code === 'ER_DUP_ENTRY'
}

// —— 渠道 ——

/** @param {any} ctx */
export const listChannels = (ctx) => q(ctx, `SELECT ${CHANNEL_COLS} FROM notify_channel WHERE $t ORDER BY type`, [])

/** @param {any} ctx @param {string} id */
export const channelById = (ctx, id) => one(ctx, `SELECT ${CHANNEL_COLS} FROM notify_channel WHERE $t AND id = $1`, [id])

/** @param {any} ctx @param {string} type */
export const channelByType = (ctx, type) =>
  one(ctx, `SELECT ${CHANNEL_COLS} FROM notify_channel WHERE $t AND type = $1`, [type])

/**
 * @param {any} ctx
 * @param {{ id: string, type: string, enabled: boolean, config: unknown, now: Date }} c
 */
export const insertChannel = (ctx, c) =>
  exec(
    ctx,
    `INSERT INTO notify_channel (tenant_id, id, type, enabled, config, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, $6)`,
    [ctx.tenantId, c.id, c.type, c.enabled, JSON.stringify(c.config ?? {}), c.now],
  )

/**
 * 乐观锁：0 行 = 被并发改过 → svc 转 409
 * @param {any} ctx
 * @param {{ id: string, enabled: boolean, config: unknown, expectedVersion: number, now: Date }} c
 */
export const updateChannel = (ctx, c) =>
  exec(
    ctx,
    `UPDATE notify_channel SET enabled = $1, config = $2, version = version + 1, updated_at = $3
      WHERE $t AND id = $4 AND version = $5`,
    [c.enabled, JSON.stringify(c.config ?? {}), c.now, c.id, c.expectedVersion],
  )

// —— 模板 ——

/** @param {any} ctx */
export const listTemplates = (ctx) =>
  q(ctx, `SELECT ${TEMPLATE_COLS} FROM notify_template WHERE $t ORDER BY code, channel, lang`, [])

/** @param {any} ctx @param {string} id */
export const templateById = (ctx, id) =>
  one(ctx, `SELECT ${TEMPLATE_COLS} FROM notify_template WHERE $t AND id = $1`, [id])

/**
 * 取模板：指定语言优先，找不到退到同 code+channel 的任意语言（v1 只有 zh/en）
 * @param {any} ctx @param {string} code @param {string} channel @param {string} lang
 */
export async function templateFor(ctx, code, channel, lang) {
  const exact = await one(
    ctx,
    `SELECT ${TEMPLATE_COLS} FROM notify_template WHERE $t AND code = $1 AND channel = $2 AND lang = $3`,
    [code, channel, lang],
  )
  if (exact) return exact
  return one(
    ctx,
    `SELECT ${TEMPLATE_COLS} FROM notify_template WHERE $t AND code = $1 AND channel = $2 ORDER BY lang`,
    [code, channel],
  )
}

/** 该事件有没有配过任何渠道的模板（决定 inapp 之外要不要多建行） */
/** @param {any} ctx @param {string} code */
export const templateChannels = (ctx, code) =>
  q(ctx, `SELECT DISTINCT channel FROM notify_template WHERE $t AND code = $1`, [code])

/**
 * @param {any} ctx
 * @param {{ id: string, code: string, channel: string, lang: string, subject: string | null, body: string, now: Date }} t
 */
export const insertTemplate = (ctx, t) =>
  exec(
    ctx,
    `INSERT INTO notify_template (tenant_id, id, code, channel, lang, subject, body, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
    [ctx.tenantId, t.id, t.code, t.channel, t.lang, t.subject, t.body, t.now],
  )

/**
 * @param {any} ctx
 * @param {{ id: string, lang: string, subject: string | null, body: string, expectedVersion: number, now: Date }} t
 */
export const updateTemplate = (ctx, t) =>
  exec(
    ctx,
    `UPDATE notify_template SET lang = $1, subject = $2, body = $3, version = version + 1, updated_at = $4
      WHERE $t AND id = $5 AND version = $6`,
    [t.lang, t.subject, t.body, t.now, t.id, t.expectedVersion],
  )

// —— outbox ——

/**
 * @param {any} ctx
 * @param {{ id: string, channel: string, toAddr: string, templateCode: string, vars: unknown, status: string, error: string | null, dedupeKey: string, now: Date }} o
 */
export const insertOutbox = (ctx, o) =>
  exec(
    ctx,
    `INSERT INTO notify_outbox (tenant_id, id, channel, to_addr, template_code, vars, status, attempts, next_retry_at, error, dedupe_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, $8, $9, $10)`,
    [ctx.tenantId, o.id, o.channel, o.toAddr, o.templateCode, JSON.stringify(o.vars ?? {}), o.status, o.error, o.dedupeKey, o.now],
  )

/** @param {any} ctx @param {string} dedupeKey */
export const outboxByDedupe = (ctx, dedupeKey) =>
  one(ctx, `SELECT id, status FROM notify_outbox WHERE $t AND dedupe_key = $1`, [dedupeKey])

/**
 * worker 取任务：跨租户、一次 20 条、`FOR UPDATE SKIP LOCKED` 保证多实例不抢同一条。
 * 两库都支持（PG 9.5+ / MySQL 8+）。`sending` 超过租约（由 next_retry_at 表示）可被重领 —— 崩了的 worker 不会把消息永久锁死。
 * @param {any} dbCtx 必须是带 conn 的事务上下文
 * @param {Date} now
 * @param {number} limit
 */
export const claimOutbox = (dbCtx, now, limit) =>
  q(
    dbCtx,
    // tenant-free：worker 一轮要取**所有租户**的待发任务（系统级消费者），
    // 取出来后按 row.tenant_id 派生每行的租户上下文，业务侧不会有跨租户读写。
    `SELECT tenant_id, ${OUTBOX_COLS} FROM notify_outbox
      WHERE ((status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= $1))
          OR (status = 'sending' AND next_retry_at <= $1))
      ORDER BY created_at ASC, id ASC
      LIMIT $2 FOR UPDATE SKIP LOCKED /* tenant-free */`,
    [now, limit],
  )

/**
 * 领走：status=sending + 租约（默认 5 分钟）。租约到期说明 worker 已死，可被别的实例重领。
 * @param {any} ctx @param {string} id @param {Date} leaseUntil
 */
export const markSending = (ctx, id, leaseUntil) =>
  exec(ctx, `UPDATE notify_outbox SET status = 'sending', next_retry_at = $1 WHERE $t AND id = $2`, [leaseUntil, id])

/** @param {any} ctx @param {string} id */
export const markSent = (ctx, id) =>
  exec(ctx, `UPDATE notify_outbox SET status = 'sent', next_retry_at = NULL, error = NULL WHERE $t AND id = $1`, [id])

/**
 * @param {any} ctx @param {{ id: string, attempts: number, nextRetryAt: Date | null, status: 'pending'|'failed', error: string }} p
 */
export const markRetry = (ctx, p) =>
  exec(
    ctx,
    `UPDATE notify_outbox SET status = $1, attempts = $2, next_retry_at = $3, error = $4 WHERE $t AND id = $5`,
    [p.status, p.attempts, p.nextRetryAt, p.error, p.id],
  )

// —— inbox ——

/**
 * 站内信列表：未读优先 + (created_at, id) 倒序。
 *
 * 排序键是三元的 `(read_at IS NULL, created_at, id)`，所以游标条件写成行比较 ——
 * PG 的行比较与 MySQL 8 的行构造器比较语义一致（true/1 排在 false/0 前），
 * 不需要 OFFSET，也不需要把已读/未读拆成两条 SQL。
 * @param {any} ctx
 * @param {{ userId: string, limit: number, cursor: { unread: boolean, at: Date, id: string } | null }} p
 */
export function inboxPage(ctx, p) {
  /** @type {unknown[]} */
  const args = [p.userId]
  let cond = ''
  if (p.cursor) {
    args.push(p.cursor.unread ? 1 : 0, p.cursor.at, p.cursor.id)
    cond = ' AND ((read_at IS NULL), created_at, id) < ($2, $3, $4)'
  }
  args.push(p.limit)
  return q(
    ctx,
    `SELECT ${INBOX_COLS} FROM notify_inbox WHERE $t AND user_id = $1${cond}
      ORDER BY (read_at IS NULL) DESC, created_at DESC, id DESC LIMIT $${args.length}`,
    args,
  )
}

/** @param {any} ctx @param {string} userId */
export const unreadCount = (ctx, userId) =>
  one(ctx, `SELECT COUNT(*) AS n FROM notify_inbox WHERE $t AND user_id = $1 AND read_at IS NULL`, [userId])

/**
 * @param {any} ctx
 * @param {{ id: string, userId: string, title: string, body: string | null, link: string | null, now: Date }} m
 */
export const insertInbox = (ctx, m) =>
  exec(
    ctx,
    `INSERT INTO notify_inbox (tenant_id, id, user_id, title, body, link, read_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)`,
    [ctx.tenantId, m.id, m.userId, m.title, m.body, m.link, m.now],
  )

/** @param {any} ctx @param {string} id @param {string} userId */
export const inboxById = (ctx, id, userId) =>
  one(ctx, `SELECT ${INBOX_COLS} FROM notify_inbox WHERE $t AND id = $1 AND user_id = $2`, [id, userId])

/** @param {any} ctx @param {{ id: string, userId: string, now: Date }} p */
export const markRead = (ctx, p) =>
  exec(
    ctx,
    `UPDATE notify_inbox SET read_at = $1 WHERE $t AND id = $2 AND user_id = $3 AND read_at IS NULL`,
    [p.now, p.id, p.userId],
  )

/** @param {any} ctx @param {{ userId: string, now: Date }} p */
export const markAllRead = (ctx, p) =>
  exec(ctx, `UPDATE notify_inbox SET read_at = $1 WHERE $t AND user_id = $2 AND read_at IS NULL`, [p.now, p.userId])

// —— 收件人解析（跨域只读）——

/**
 * 角色 → 有效成员。刻意拆两条：`$t` 会被展开成裸 `tenant_id = $n`，
 * 多表 JOIN 里 `tenant_id` 会有歧义，所以角色先查 id，成员查询只 JOIN 无 tenant_id 的 auth_user。
 * @param {any} ctx @param {string} roleCode
 */
export async function usersByRole(ctx, roleCode) {
  const role = await one(ctx, `SELECT id FROM auth_role WHERE $t AND code = $1`, [roleCode])
  if (!role) return []
  return q(
    ctx,
    `SELECT u.id, u.email FROM org_membership m
       JOIN auth_user u ON u.id = m.user_id
      WHERE $t AND m.role_id = $1 AND m.status = 'active' AND u.status = 'active'
      ORDER BY u.id`,
    [role.id],
  )
}

/** @param {any} ctx @param {string} userId */
export const userById = (ctx, userId) =>
  one(ctx, `SELECT id, email FROM auth_user WHERE id = $1 AND status = 'active'`, [userId])

/** 这个 user 是不是本租户的有效成员（auth_user 是全局表，必须额外挡一次） */
/** @param {any} ctx @param {string} userId */
export const isMember = (ctx, userId) =>
  one(ctx, `SELECT 1 AS ok FROM org_membership WHERE $t AND user_id = $1 AND status = 'active'`, [userId])

/**
 * `{ field: 'xxx.column' }` 白名单 = 「一行一条写死的 SQL」。
 * 绝不拼接表名/列名：拼表名的文件会被 test/tenant_guard 直接判死，
 * 而且拼接是唯一能把注入口子开出来的写法。
 * @type {Record<string, (ctx: any, docId: string) => Promise<{ v: string | null } | null>> }
 */
export const FIELD_READERS = {
  'project.pm_user_id': (ctx, docId) =>
    one(ctx, `SELECT pm_user_id AS v FROM project WHERE $t AND id = $1`, [docId]),
}
