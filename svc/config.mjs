import * as store from '../store/config.mjs'

/**
 * 租户级系统配置。和 svc/settings.mjs（全局 platform_settings）分开：
 * 这里是每家公司自己的开关，互不影响。
 *
 * 现在只有一项，就不过度设计成通用配置中心 —— 加一项就往 DEFAULTS 里加一行。
 */
export const DEFAULTS = {
  /** 单据编号是否自动生成；关掉就必须手工填（有些客户有自己的编码体系） */
  'code.auto': 'true',
}

const TTL_MS = 30_000

/** @type {Map<string, { at: number, data: Record<string, string> }>} */
const cache = new Map()

/** @param {any} ctx */
export async function all(ctx) {
  const tenantId = String(ctx?.tenantId ?? '')
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data
  /** @type {Record<string, string>} */
  const data = { ...DEFAULTS }
  for (const row of await store.all(ctx)) data[row.config_key] = row.config_value
  cache.set(tenantId, { at: Date.now(), data })
  return data
}

/**
 * @param {any} ctx
 * @param {keyof typeof DEFAULTS} key
 */
export async function get(ctx, key) {
  const data = await all(ctx)
  return data[key] ?? ''
}

/** @param {any} ctx */
export async function isCodeAuto(ctx) {
  return (await get(ctx, 'code.auto')) !== 'false'
}

/**
 * @param {any} ctx
 * @param {string} key
 * @param {string} value
 */
export async function set(ctx, key, value) {
  if (!(key in DEFAULTS)) throw new Error(`未知配置项 ${key}`)
  await store.put(ctx, key, value)
  // 本进程立即生效；别的实例最长 30 秒
  cache.delete(String(ctx?.tenantId ?? ''))
}

/** 测试隔离用 */
export function resetCache() {
  cache.clear()
}
