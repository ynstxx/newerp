import { need } from '../auth/perm.mjs'
import { only, readJson } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/integration.mjs'
import { handleCallback } from '../svc/integration_oauth.mjs'

const FIELDS = ['corpId', 'agentId', 'secrets', 'enabled', 'corp_id', 'agent_id']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SPEC = {
  corpId: { type: 'string', max: 64 },
  agentId: { type: 'string', max: 64 },
  enabled: { type: 'bool' },
}

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const PROVIDER_SPEC = {
  provider: { type: 'enum', values: [...svc.PROVIDERS], required: true },
}

/**
 * secrets 永远是对象；只接受字符串值，避免 JSON 嵌套把"配置"变成不可控结构。
 * @param {unknown} raw
 * @returns {Record<string, string> | undefined}
 */
function secretsOf(raw) {
  if (raw === undefined) return undefined
  if (raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(errors.badRequest, { reason: 'secrets 必须是对象' })
  }
  /** @type {Record<string, string>} */
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') throw new HttpError(errors.badRequest, { reason: `secrets.${k} 必须是字符串` })
    out[k] = v.trim()
  }
  return out
}

/**
 * API 同时容忍 camelCase 与表列名 snake_case，落库前统一成 camelCase。
 * @param {Record<string, unknown>} body
 */
function normalize(body) {
  return {
    corpId: body.corpId ?? body.corp_id,
    agentId: body.agentId ?? body.agent_id,
    secrets: secretsOf(body.secrets),
    enabled: body.enabled,
  }
}

/** @type {import('../http/router.mjs').Handler} */
export async function list(ctx) {
  need(ctx, 'integration:view')
  sendJson(ctx.res, 200, await svc.listConns(ctx))
}

/** @type {import('../http/router.mjs').Handler} */
export async function create(ctx) {
  need(ctx, 'integration:config')
  const body = only(await readJson(ctx), ['provider', ...FIELDS])
  const provider = validate(body, PROVIDER_SPEC)
  const input = validate(body, SPEC, { partial: true })
  const out = await svc.createConn(ctx, {
    provider: String(provider.provider),
    corpId: /** @type {string | undefined} */ (input.corpId),
    agentId: /** @type {string | undefined} */ (input.agentId),
    secrets: secretsOf(body.secrets),
    enabled: /** @type {boolean | undefined} */ (input.enabled),
  })
  sendJson(ctx.res, 201, out)
}

/** @type {import('../http/router.mjs').Handler} */
export async function update(ctx) {
  need(ctx, 'integration:config')
  const body = only(await readJson(ctx), FIELDS)
  const patch = validate(body, SPEC, { partial: true })
  const normalized = normalize(body)
  const out = await svc.updateConn(ctx, ctx.params.id, {
    corpId: /** @type {string | undefined} */ (patch.corpId ?? normalized.corpId),
    agentId: /** @type {string | undefined} */ (patch.agentId ?? normalized.agentId),
    secrets: normalized.secrets,
    enabled: /** @type {boolean | undefined} */ (patch.enabled),
  })
  sendJson(ctx.res, 200, out)
}

/** @type {import('../http/router.mjs').Handler} */
export async function sync(ctx) {
  need(ctx, 'integration:config')
  const out = await svc.syncNow(ctx, ctx.params.id)
  sendJson(ctx.res, 200, out)
}

/** @type {import('../http/router.mjs').Handler} */
export async function logs(ctx) {
  need(ctx, 'integration:view')
  const limit = Number(ctx.url.searchParams.get('limit') ?? 20)
  sendJson(ctx.res, 200, await svc.syncLogs(ctx, ctx.params.id, limit))
}

/** @type {import('../http/router.mjs').Handler} */
export async function authUrl(ctx) {
  need(ctx, 'integration:view')
  sendJson(ctx.res, 200, { url: await svc.authUrlOf(ctx, ctx.params.id) })
}

/**
 * 全局回调（不带 /t/{slug}）。租户 slug 只在签名过的 state 里。
 * @type {import('../http/router.mjs').Handler}
 */
export async function oauthCallback(ctx) {
  const code = ctx.url.searchParams.get('code') ?? ''
  const out = await handleCallback(ctx, ctx.params.provider, code)
  ctx.res.writeHead(302, { location: out.redirect })
  ctx.res.end()
}
