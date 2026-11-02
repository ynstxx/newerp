import * as store from '../store/settings.mjs'

/** 环境变量给初始值，platform_settings 表覆盖（DESIGN §4.6） */
export const DEFAULTS = {
  'registration.mode': process.env.REGISTRATION_MODE ?? 'invite',
  'registration.captcha': process.env.REGISTRATION_CAPTCHA ?? 'none',
  'registration.email_domain_whitelist': process.env.REGISTRATION_EMAIL_DOMAIN_WHITELIST ?? '',
  'registration.require_admin_approval': 'false',
  'registration.default_plan': 'free',
  'registration.tenant_name_template': '{user}的公司',
}

const TTL_MS = 30_000

/** @type {{ at: number, data: Record<string, string> | null }} */
let cache = { at: 0, data: null }

/**
 * 全部配置。30 秒缓存 —— 改库后最多半分钟生效，本进程 set() 立即失效。
 * ponytail: 进程内单份缓存，多实例各自过期，30s 窗口可接受
 * @param {any} ctx
 */
export async function all(ctx) {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data
  /** @type {Record<string, string>} */
  const data = { ...DEFAULTS }
  for (const row of await store.all(ctx)) data[row.setting_key] = row.setting_value
  cache = { at: Date.now(), data }
  return data
}

/**
 * @param {any} ctx
 * @param {keyof typeof DEFAULTS | string} key
 */
export async function get(ctx, key) {
  const data = await all(ctx)
  return data[key] ?? ''
}

/** @param {any} ctx @param {string} key @param {string} value */
export async function set(ctx, key, value) {
  if (!(key in DEFAULTS)) throw new Error(`未知配置项 ${key}`)
  await store.put(ctx, key, value)
  cache = { at: 0, data: null }
}

/** 测试用：清掉进程内缓存 */
export function resetCache() {
  cache = { at: 0, data: null }
}
