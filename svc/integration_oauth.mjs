import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { config } from '../config.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import * as session from '../auth/session.mjs'
import * as store from '../store/integration.mjs'
import * as tenants from '../store/tenant.mjs'
import { accessToken, exchangeUser } from './integration_api.mjs'
import { decryptJson } from './integration_crypto.mjs'
import { authBase, normalizeProvider } from './integration_providers.mjs'

const STATE_TTL_MS = 10 * 60 * 1000

const signKey = () => `newerp:oauth:${config.secret}`
const b64 = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('base64url')
const sig = (/** @type {string} */ s) => createHmac('sha256', signKey()).update(s).digest('base64url')

/**
 * state 里只放租户 slug（全局回调路径没有 /t/{slug}），并做 HMAC 防篡改。
 * @param {{ tenantSlug: string, provider: string }} input
 */
export function signState(input) {
  const payload = b64(
    JSON.stringify({
      t: input.tenantSlug,
      p: input.provider,
      n: randomUUID(),
      exp: Date.now() + STATE_TTL_MS,
    }),
  )
  return `${payload}.${sig(payload)}`
}

/**
 * @param {string} state
 * @returns {{ t: string, p: string, n: string, exp: number }}
 */
export function verifyState(state) {
  const [payload, signature] = String(state ?? '').split('.')
  if (!payload || !signature) throw new HttpError(errors.badRequest, { reason: 'state 无效' })

  const expected = Buffer.from(sig(payload))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new HttpError(errors.badRequest, { reason: 'state 签名无效' })
  }

  /** @type {any} */
  let data
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw new HttpError(errors.badRequest, { reason: 'state 内容无效' })
  }
  if (!data?.t || !data?.p || Number(data.exp) <= Date.now()) {
    throw new HttpError(errors.badRequest, { reason: 'state 已过期，请重新发起登录' })
  }
  return data
}

/**
 * 拼官方授权页。真实部署时 appkey/corp_id 来自 integration_conn，不允许前端传。
 * @param {string} provider
 * @param {{ tenantSlug?: string, corpId?: string, appKey?: string, redirectUri?: string, origin?: string, state?: string }} [opts]
 * @returns {string}
 */
export function buildAuthUrl(provider, opts = {}) {
  const p = normalizeProvider(provider)
  const origin = String(opts.origin ?? 'http://localhost').replace(/\/+$/, '')
  const redirectUri = opts.redirectUri ?? `${origin}/api/auth/oauth/${p}/callback`
  const state = opts.state ?? signState({ tenantSlug: opts.tenantSlug ?? '', provider: p })

  if (p === 'dingtalk') {
    const u = new URL(`${authBase(p)}/oauth2/auth`)
    u.searchParams.set('redirect_uri', redirectUri)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('client_id', opts.appKey ?? '')
    u.searchParams.set('scope', 'openid')
    u.searchParams.set('state', state)
    u.searchParams.set('prompt', 'consent')
    return u.toString()
  }

  const u = new URL(`${authBase(p)}/connect/oauth2/authorize`)
  u.searchParams.set('appid', opts.corpId ?? '')
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', 'snsapi_base')
  u.searchParams.set('state', state)
  return `${u.toString()}#wechat_redirect`
}

/**
 * 扫码回调：code → 外部 userid → integration_map → 本地 auth_user → 建会话。
 * 未映射一律报错，不自动建号（避免越权）。
 * @param {any} ctx 全局上下文（无 tenant 前缀）
 * @param {string} provider
 * @param {string} code
 */
export async function handleCallback(ctx, provider, code) {
  const p = normalizeProvider(provider)
  if (!code) throw new HttpError(errors.badRequest, { reason: '缺少 code' })

  const state = verifyState(ctx.url.searchParams.get('state') ?? '')
  if (state.p !== p) throw new HttpError(errors.badRequest, { reason: 'state 与 provider 不匹配' })

  const tenant = await tenants.bySlug(ctx, state.t)
  if (!tenant || tenant.status !== 'active') throw new HttpError(errors.notFound)

  const tctx = {
    ...ctx,
    tenantId: tenant.id,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, plan: tenant.plan },
  }
  const conn = await store.connByProvider(tctx, p)
  if (!conn || !conn.enabled) throw new HttpError(errors.badRequest, { reason: `${p} 集成未启用` })
  if (!conn.secrets) throw new HttpError(errors.badRequest, { reason: '集成密钥未配置' })

  const base = ctx.integrationFetchBaseUrl ?? ctx.fetchBaseUrl
  let externalId = ''
  try {
    const secrets = decryptJson(String(conn.secrets))
    const token = await accessToken(
      p,
      { ...secrets, corpid: secrets.corpid ?? secrets.corp_id ?? conn.corp_id },
      base,
    )
    externalId = await exchangeUser(p, token, code, base)
  } catch (err) {
    throw new HttpError(errors.badRequest, {
      reason: `扫码登录失败：${err instanceof Error ? err.message : String(err)}`,
    })
  }

  const map = await store.mapByKey(tctx, { provider: p, externalType: 'user', externalId })
  if (!map) {
    throw new HttpError(errors.forbidden, {
      reason: '该账号尚未映射到本地用户，请联系管理员先同步通讯录（系统不会自动建号）',
    })
  }

  const user = await store.userById(tctx, map.local_id)
  if (!user || user.status !== 'active') {
    throw new HttpError(errors.forbidden, { reason: '本地账号不存在或已停用，请联系管理员' })
  }
  const mem = await store.membershipByUser(tctx, user.id)
  if (!mem || mem.status !== 'active') {
    throw new HttpError(errors.forbidden, { reason: '你在本公司的成员身份已停用，请联系管理员' })
  }

  // 会话落在全局 auth_session；tenant_id 只做记录，实际租户仍由 /t/{slug} 中间件校验
  await session.create(ctx, user.id, tenant.id)
  return { userId: user.id, tenantId: tenant.id, slug: tenant.slug, redirect: `/t/${tenant.slug}/` }
}
