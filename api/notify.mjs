import { randomUUID } from 'node:crypto'
import { need, needUser } from '../auth/perm.mjs'
import { only, readJson } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { validate } from '../http/validate.mjs'
import { withTx } from '../db/index.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/notify.mjs'
import * as svc from '../svc/notify.mjs'

/**
 * 通知中心 API。api/ 无 SQL，全部走 store/svc。
 * 租户前缀（/t/{slug}）已由 auth/tenant.mjs 剥掉，这里只写 /api/notify/…
 */

/** 配置类操作的权限点（直接用字符串，不改 auth/perm.mjs） */
export const CONFIG_PERM = 'notify:config'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {string} id */
function assertId(id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

// —— 游标 ——

/**
 * 站内信的排序键是三元组 `(未读, created_at, id)`，游标里多存一段 `u|r`。
 * 段内仍走行比较（store.inboxPage），不用 OFFSET。
 * @param {string | null} raw
 * @returns {{ unread: boolean, at: Date, id: string } | null}
 */
function decodeCursor(raw) {
  if (!raw) return null
  const [flag, at, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|')
  const date = new Date(at ?? '')
  if ((flag !== 'u' && flag !== 'r') || !UUID.test(id ?? '') || Number.isNaN(date.getTime())) {
    throw new HttpError(errors.badRequest, { reason: 'cursor 无效' })
  }
  return { unread: flag === 'u', at: date, id }
}

/** @param {any} row */
const encodeCursor = (row) =>
  Buffer.from(
    `${row.read_at === null || row.read_at === undefined ? 'u' : 'r'}|${new Date(row.created_at).toISOString()}|${row.id}`,
    'utf8',
  ).toString('base64url')

// —— 站内信 ——

/**
 * 分页参数自己解析：`http/page.mjs` 的 parsePage 只认 `created_at|id` 两元游标，
 * 站内信的排序键是三元组，塞不进去 —— 硬凑会在 parsePage 里被判成非法游标 400。
 * ponytail: 只有这一处需要三元游标，等第二处出现再往 http/page.mjs 抽通用版本。
 */
/** @type {import('../http/router.mjs').Handler} */
export async function inboxList(ctx) {
  needUser(ctx)
  const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit')) || 20, 1), 100)
  const cursor = decodeCursor(ctx.url.searchParams.get('cursor'))
  const rows = await store.inboxPage(ctx, { userId: String(ctx.userId), limit: limit + 1, cursor })
  const more = rows.length > limit
  const items = more ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  const unread = /** @type {any} */ (await store.unreadCount(ctx, String(ctx.userId)))
  sendJson(ctx.res, 200, {
    items: items.map(svc.inboxToApi),
    nextCursor: more && last ? encodeCursor(last) : null,
    unread: Number(unread?.n ?? 0),
  })
}

/** @type {import('../http/router.mjs').Handler} */
export async function inboxRead(ctx) {
  needUser(ctx)
  const id = assertId(ctx.params.id)
  const userId = String(ctx.userId)
  const row = await store.inboxById(ctx, id, userId)
  if (!row) throw new HttpError(errors.notFound)

  if (!row.read_at) {
    const now = new Date()
    await withTx(ctx, async (tx) => {
      await store.markRead(tx, { id, userId, now })
      await audit.insert(tx, {
        id: randomUUID(),
        module: 'notify',
        action: 'inbox.read',
        whoId: userId,
        refType: 'notify_inbox',
        refId: id,
        before: null,
        after: { readAt: now },
        traceId: ctx.requestId ?? '',
        at: now,
      })
    })
  }
  const after = await store.inboxById(ctx, id, userId)
  sendJson(ctx.res, 200, svc.inboxToApi(after ?? { ...row, read_at: row.read_at ?? new Date() }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function inboxReadAll(ctx) {
  needUser(ctx)
  const userId = String(ctx.userId)
  const now = new Date()
  const marked = await withTx(ctx, async (tx) => {
    const n = await store.markAllRead(tx, { userId, now })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'notify',
      action: 'inbox.read_all',
      whoId: userId,
      refType: null,
      refId: null,
      before: null,
      after: { marked: n },
      traceId: ctx.requestId ?? '',
      at: now,
    })
    return n
  })
  sendJson(ctx.res, 200, { marked, unread: 0 })
}

// —— 渠道 ——

/** @type {import('../http/router.mjs').Handler} */
export async function channelList(ctx) {
  need(ctx, CONFIG_PERM)
  sendJson(ctx.res, 200, await svc.listChannels(ctx))
}

const CHANNEL_CREATE_FIELDS = ['type', 'enabled', 'config']
const CHANNEL_PUT_FIELDS = ['enabled', 'config', 'version']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const CHANNEL_CREATE_SPEC = {
  type: { type: 'string', required: true, max: 32 },
  enabled: { type: 'bool' },
}

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const CHANNEL_PUT_SPEC = {
  enabled: { type: 'bool' },
  version: { type: 'int' },
}

/** @param {unknown} v */
function assertConfigObject(v) {
  if (v === undefined) return undefined
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpError(errors.badRequest, { fields: { config: 'object' } })
  }
  return /** @type {Record<string, unknown>} */ (v)
}

/** @type {import('../http/router.mjs').Handler} */
export async function channelCreate(ctx) {
  need(ctx, CONFIG_PERM)
  const body = only(await readJson(ctx), CHANNEL_CREATE_FIELDS)
  const input = /** @type {{ type: string, enabled?: boolean }} */ (validate(body, CHANNEL_CREATE_SPEC))
  const config = assertConfigObject(body.config)
  sendJson(ctx.res, 201, await svc.createChannel(ctx, { ...input, config }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function channelPut(ctx) {
  need(ctx, CONFIG_PERM)
  const body = only(await readJson(ctx), CHANNEL_PUT_FIELDS)
  const patch = validate(body, CHANNEL_PUT_SPEC)
  const config = assertConfigObject(body.config)
  sendJson(ctx.res, 200, await svc.updateChannel(ctx, ctx.params.id, { ...patch, config }))
}

// —— 模板 ——

/** @type {import('../http/router.mjs').Handler} */
export async function templateList(ctx) {
  need(ctx, CONFIG_PERM)
  sendJson(ctx.res, 200, await svc.listTemplates(ctx))
}

const TEMPLATE_CREATE_FIELDS = ['code', 'channel', 'lang', 'subject', 'body']
const TEMPLATE_PUT_FIELDS = ['lang', 'subject', 'body', 'version']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const TEMPLATE_CREATE_SPEC = {
  code: { type: 'string', required: true, max: 64 },
  channel: { type: 'string', required: true, max: 32 },
  lang: { type: 'string', max: 8 },
  subject: { type: 'string', max: 500 },
  body: { type: 'string', required: true, max: 20_000 },
}

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const TEMPLATE_PUT_SPEC = {
  lang: { type: 'string', max: 8 },
  subject: { type: 'string', max: 500 },
  body: { type: 'string', max: 20_000 },
  version: { type: 'int' },
}

/** @type {import('../http/router.mjs').Handler} */
export async function templateCreate(ctx) {
  need(ctx, CONFIG_PERM)
  const body = only(await readJson(ctx), TEMPLATE_CREATE_FIELDS)
  const input = validate(body, TEMPLATE_CREATE_SPEC)
  sendJson(
    ctx.res,
    201,
    await svc.createTemplate(ctx, /** @type {any} */ (input)),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function templatePut(ctx) {
  need(ctx, CONFIG_PERM)
  const body = only(await readJson(ctx), TEMPLATE_PUT_FIELDS)
  const patch = validate(body, TEMPLATE_PUT_SPEC)
  sendJson(ctx.res, 200, await svc.updateTemplate(ctx, ctx.params.id, patch))
}

// —— 测试消息 ——

/** @type {import('../http/router.mjs').Handler} */
export async function testSend(ctx) {
  needUser(ctx)
  const body = only(await readJson(ctx), ['channel'])
  const input = validate(body, { channel: { type: 'string', required: true, max: 32 } })
  sendJson(ctx.res, 200, await svc.sendTest(ctx, /** @type {any} */ (input)))
}
