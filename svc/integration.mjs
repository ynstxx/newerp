import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/integration.mjs'
import { decryptJson, encryptJson } from './integration_crypto.mjs'
import { buildAuthUrl } from './integration_oauth.mjs'
import { normalizeProvider, PROVIDERS } from './integration_providers.mjs'
import { syncOrg } from './integration_sync.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export { PROVIDERS }

/** @param {string} id */
function assertId(id) {
  if (!UUID.test(String(id))) throw new HttpError(errors.notFound)
  return String(id)
}

/** 对外只暴露"密钥已配置"，密文和明文都不出网。 */
const toApi = (/** @type {any} */ c) => ({
  id: c.id,
  provider: c.provider,
  corpId: c.corp_id,
  agentId: c.agent_id,
  secrets: { configured: Boolean(c.secrets) },
  enabled: Boolean(c.enabled),
  lastSyncAt: c.last_sync_at,
  version: c.version,
})

/** @param {any} ctx */
export async function listConns(ctx) {
  const rows = await store.listConns(ctx)
  return { items: rows.map(toApi), nextCursor: null }
}

/** @param {any} ctx @param {string} id */
async function requireConn(ctx, id) {
  const row = await store.connById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return row
}

/**
 * @param {any} ctx
 * @param {{ provider: string, corpId?: string, agentId?: string, secrets?: Record<string, string>, enabled?: boolean }} input
 */
export async function createConn(ctx, input) {
  const provider = normalizeProvider(input.provider)
  if (await store.connByProvider(ctx, provider)) {
    throw new HttpError(errors.conflict, { reason: `${provider} 集成已存在` })
  }
  const now = new Date()
  const id = randomUUID()
  const secrets = input.secrets ? encryptJson(input.secrets) : null

  await withTx(ctx, async (tx) => {
    await store.insertConn(tx, {
      id,
      provider,
      corpId: input.corpId ?? null,
      agentId: input.agentId ?? null,
      secrets,
      enabled: Boolean(input.enabled),
      lastSyncAt: null,
      version: 1,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'integration',
      action: 'create',
      whoId: ctx.userId ?? null,
      refType: 'integration_conn',
      refId: id,
      before: null,
      after: { provider, corpId: input.corpId ?? null, enabled: Boolean(input.enabled), secretsConfigured: Boolean(secrets) },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return toApi(await store.connById(ctx, id))
}

/**
 * @param {any} ctx
 * @param {string} id
 * @param {{ corpId?: string, agentId?: string, secrets?: Record<string, string>, enabled?: boolean }} patch
 */
export async function updateConn(ctx, id, patch) {
  const cur = await requireConn(ctx, id)
  const now = new Date()

  /** @type {string | null} */
  let secrets = cur.secrets ?? null
  if (patch.secrets !== undefined) {
    /** @type {Record<string, string>} */
    let old = {}
    if (cur.secrets) {
      try {
        old = decryptJson(String(cur.secrets))
      } catch {
        old = {}
      }
    }
    // 局部更新：只传 corpsecret 时不能把 appkey 抹掉
    secrets = encryptJson({ ...old, ...patch.secrets })
  }

  const next = {
    corpId: patch.corpId !== undefined ? patch.corpId : cur.corp_id,
    agentId: patch.agentId !== undefined ? patch.agentId : cur.agent_id,
    secrets,
    enabled: patch.enabled !== undefined ? patch.enabled : Boolean(cur.enabled),
  }

  await withTx(ctx, async (tx) => {
    const n = await store.updateConn(tx, { id, expectedVersion: cur.version, ...next })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'integration',
      action: 'update',
      whoId: ctx.userId ?? null,
      refType: 'integration_conn',
      refId: id,
      before: toApi(cur),
      after: { ...toApi(cur), ...next, secrets: { configured: Boolean(next.secrets) } },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return toApi(await store.connById(ctx, id))
}

/** @param {any} ctx @param {string} id */
export async function syncNow(ctx, id) {
  const conn = await requireConn(ctx, id)
  if (!conn.enabled) throw new HttpError(errors.conflict, { reason: `${conn.provider} 集成未启用` })
  const counts = await syncOrg(ctx, conn.provider)
  return { provider: conn.provider, counts }
}

/**
 * @param {any} ctx @param {string} id @param {number} limit
 */
export async function syncLogs(ctx, id, limit) {
  const conn = await requireConn(ctx, id)
  const rows = await store.listLogs(ctx, conn.provider, limit)
  return {
    items: rows.map((/** @type {any} */ r) => ({
      id: r.id,
      provider: r.provider,
      action: r.action,
      counts: typeof r.counts === 'string' ? JSON.parse(r.counts) : r.counts,
      error: r.error,
      at: r.at,
    })),
    nextCursor: null,
  }
}

/** @param {any} ctx @param {string} id */
export async function authUrlOf(ctx, id) {
  const conn = await requireConn(ctx, id)
  if (!conn.secrets) throw new HttpError(errors.badRequest, { reason: '集成密钥未配置' })
  const secrets = decryptJson(String(conn.secrets))
  const provider = normalizeProvider(conn.provider)
  const redirectUri = `${ctx.url.origin}/api/auth/oauth/${provider}/callback`
  return buildAuthUrl(provider, {
    tenantSlug: ctx.tenant?.slug ?? '',
    corpId: conn.corp_id ?? secrets.corpid ?? secrets.corp_id ?? '',
    appKey: secrets.appkey ?? secrets.app_key ?? '',
    redirectUri,
  })
}
