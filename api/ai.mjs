import { need } from '../auth/perm.mjs'
import { only, readJson } from '../http/body.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { sendJson } from '../http/context.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as client from '../svc/ai_client.mjs'
import * as svc from '../svc/ai_draft.mjs'
import * as settings from '../svc/ai_settings.mjs'

/**
 * AI 端点（DESIGN §12）。
 * 权限点直接用字符串，不改 auth/perm.mjs（并行契约）。
 * 离线降级：除 settings 外的功能入口在未启用/无 key 时一律 503（settings 必须可访问才能启用）。
 */
const CONFIG = 'ai:config'
const CHAT = 'ai:chat'
const VIEW = 'ai:view'
const APPROVE = 'ai:approve'
const APPLY = 'ai:apply'

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SETTINGS_SPEC = {
  baseUrl: { type: 'string', max: 500 },
  apiKey: { type: 'string', max: 500 },
  model: { type: 'code', max: 64 },
  enabled: { type: 'bool' },
  maxTokens: { type: 'int' },
  timeoutMs: { type: 'int' },
  monthlyTokenLimit: { type: 'int' },
  version: { type: 'int' },
}
const SETTINGS_FIELDS = Object.keys(SETTINGS_SPEC)

/** @type {import('../http/router.mjs').Handler} */
export async function getSettings(ctx) {
  need(ctx, CONFIG)
  sendJson(ctx.res, 200, await settings.getSettings(ctx))
}

/** @type {import('../http/router.mjs').Handler} */
export async function putSettings(ctx) {
  need(ctx, CONFIG)
  const body = only(await readJson(ctx), SETTINGS_FIELDS)
  /** @type {Record<string, unknown>} */
  const patch = validate(body, SETTINGS_SPEC, { partial: true })
  // '' 表示清除密钥；validate 会丢弃空串，所以单独处理
  if ('apiKey' in body) patch.apiKey = String(body.apiKey ?? '')
  sendJson(ctx.res, 200, await settings.updateSettings(ctx, /** @type {any} */ (patch)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function chat(ctx) {
  need(ctx, CHAT)
  const body = only(await readJson(ctx), ['messages'])
  sendJson(ctx.res, 201, await svc.chat(ctx, body.messages))
}

/** @type {import('../http/router.mjs').Handler} */
export async function listDrafts(ctx) {
  need(ctx, VIEW)
  await settings.assertReady(ctx)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const status = ctx.url.searchParams.get('status') ?? undefined
  if (status !== undefined && !svc.DRAFT_STATUSES.includes(/** @type {any} */ (status))) {
    throw new HttpError(errors.badRequest, { fields: { status: `enum:${svc.DRAFT_STATUSES.join('|')}` } })
  }
  const toolName = ctx.url.searchParams.get('toolName') ?? undefined
  sendJson(ctx.res, 200, await svc.listDrafts(ctx, { ...page, status, toolName }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function getDraft(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await svc.getDraft(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function approve(ctx) {
  need(ctx, APPROVE)
  sendJson(ctx.res, 200, await svc.approve(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function reject(ctx) {
  need(ctx, APPROVE)
  const body = only(await readJson(ctx), ['reason'])
  const input = validate(body, { reason: { type: 'string', required: true, max: 500 } })
  sendJson(ctx.res, 200, await svc.reject(ctx, ctx.params.id, String(input.reason)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function apply(ctx) {
  need(ctx, APPLY)
  sendJson(ctx.res, 200, await svc.apply(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function listTraces(ctx) {
  need(ctx, VIEW)
  await settings.assertReady(ctx)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const draftId = ctx.url.searchParams.get('draftId') ?? undefined
  const model = ctx.url.searchParams.get('model') ?? undefined
  sendJson(ctx.res, 200, await client.listTraces(ctx, { ...page, draftId, model }))
}
