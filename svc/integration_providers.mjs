import { HttpError, errors } from '../http/errors.mjs'

/** 外部集成只支持这两家；新增 provider 必须同时补 auth/exchange 两条链路。 */
export const PROVIDERS = /** @type {const} */ (['dingtalk', 'wecom'])

/** @type {Record<string, string>} */
export const DEFAULT_API_BASE = {
  dingtalk: 'https://oapi.dingtalk.com',
  wecom: 'https://qyapi.weixin.qq.com',
}

/** @type {Record<string, string>} */
export const DEFAULT_AUTH_BASE = {
  dingtalk: 'https://login.dingtalk.com',
  wecom: 'https://open.weixin.qq.com',
}

/**
 * 测试注入点：把 provider 的 API 根指到本地假服务器。
 * 生产路径永远走 DEFAULT_API_BASE；只有测试会显式 set。
 * @type {Map<string, string>}
 */
const overrides = new Map()

/** @param {string} provider @param {string} url */
export function setFetchBaseUrl(provider, url) {
  overrides.set(normalizeProvider(provider), String(url).replace(/\/+$/, ''))
}

/** @param {string} [provider] */
export function clearFetchBaseUrl(provider) {
  if (provider) overrides.delete(normalizeProvider(provider))
  else overrides.clear()
}

/** @param {unknown} provider */
export function normalizeProvider(provider) {
  const p = String(provider ?? '').trim().toLowerCase()
  if (!PROVIDERS.includes(/** @type {any} */ (p))) {
    throw new HttpError(errors.badRequest, { reason: `不支持的集成类型：${provider}（只支持 ${PROVIDERS.join(' / ')}）` })
  }
  return p
}

/**
 * @param {unknown} provider
 * @param {string} [explicit]
 */
export function apiBase(provider, explicit) {
  const p = normalizeProvider(provider)
  return String(explicit ?? overrides.get(p) ?? envBase(p) ?? DEFAULT_API_BASE[p]).replace(/\/+$/, '')
}

/**
 * 测试/私有部署注入：模块级 setFetchBaseUrl 优先，其次环境变量，最后官方域名。
 * @param {string} provider
 * @returns {string | undefined}
 */
function envBase(provider) {
  return process.env[`INTEGRATION_${provider.toUpperCase()}_BASE_URL`] ?? process.env.INTEGRATION_FETCH_BASE_URL
}

/** @param {unknown} provider */
export function authBase(provider) {
  return DEFAULT_AUTH_BASE[normalizeProvider(provider)]
}
