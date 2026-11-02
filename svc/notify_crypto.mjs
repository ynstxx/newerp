import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { config } from '../config.mjs'

/**
 * 渠道配置里的密钥加密（aes-256-gcm）。
 *
 * 只加密「密钥类字段」，`base_url` / `from` 这类配置照旧明文存 —— 后台要展示、要排障，
 * 全量加密只会让运维多一次解密。密钥派生自 `APP_SECRET`（config.secret），
 * 换 APP_SECRET 等于所有已存密钥失效，这是有意为之：密钥不该能悄悄迁走。
 *
 * 存储格式：`v1.<iv>.<tag>.<ciphertext>`，全部 base64url。带版本前缀，将来换算法可平滑迁移。
 */

const VERSION = 'v1'
const ALGO = 'aes-256-gcm'

/** 这些字段名里的值视为密钥，落库前必须加密 */
export const SECRET_KEYS = [
  'api_key',
  'apiKey',
  'api_secret',
  'apiSecret',
  'webhook',
  'secret',
  'sign',
  'token',
  'password',
]

const keyOf = () => scryptSync(config.secret, 'newerp:notify:v1', 32)

/** @param {string} plaintext */
export function encrypt(plaintext) {
  const iv = randomBytes(12)
  const c = createCipheriv(ALGO, keyOf(), iv)
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return [VERSION, iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
}

/**
 * 非加密串原样返回：兼容早期直接写的明文（读得出来，下次写入就会被加密）。
 * @param {string} sealed
 */
export function decrypt(sealed) {
  const parts = String(sealed).split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) return sealed
  const d = createDecipheriv(ALGO, keyOf(), Buffer.from(parts[1], 'base64url'))
  d.setAuthTag(Buffer.from(parts[2], 'base64url'))
  return Buffer.concat([d.update(Buffer.from(parts[3], 'base64url')), d.final()]).toString('utf8')
}

const isSealed = (/** @type {unknown} */ v) => typeof v === 'string' && v.startsWith(`${VERSION}.`)

/**
 * 写入前：密钥字段加密
 * @param {Record<string, unknown>} cfg
 * @returns {Record<string, unknown>}
 */
export function sealConfig(cfg) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [k, v] of Object.entries(cfg ?? {})) {
    if (v === undefined) continue
    out[k] = SECRET_KEYS.includes(k) && typeof v === 'string' && v !== '' && !isSealed(v) ? encrypt(v) : v
  }
  return out
}

/**
 * 使用前：密钥字段解密（发送时用明文）
 * @param {Record<string, unknown> | null | undefined} cfg
 * @returns {Record<string, unknown>}
 */
export function openConfig(cfg) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [k, v] of Object.entries(cfg ?? {})) {
    out[k] = SECRET_KEYS.includes(k) && typeof v === 'string' ? decrypt(v) : v
  }
  return out
}

/**
 * 对外：密钥字段一律不出现，只告诉前端「配没配」
 * @param {Record<string, unknown> | null | undefined} cfg
 */
export function publicConfig(cfg) {
  /** @type {Record<string, unknown>} */
  const out = {}
  let configured = false
  for (const [k, v] of Object.entries(cfg ?? {})) {
    if (SECRET_KEYS.includes(k)) {
      if (v !== null && v !== undefined && v !== '') configured = true
      continue
    }
    out[k] = v
  }
  return { ...out, configured }
}
