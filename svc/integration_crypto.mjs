import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from '../config.mjs'

/**
 * 集成密钥（appsecret / webhook secret）落库前的唯一加解密入口。
 * AES-256-GCM：随机 12 字节 IV，16 字节 auth tag，输出 base64。
 * 密钥由 APP_SECRET 派生（sha256），所以换 APP_SECRET 后旧密文会解不开 —— 这是预期的。
 */

const ALG = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

const key = () => createHash('sha256').update(`newerp:integration:${config.secret}`, 'utf8').digest()

/**
 * @param {string} text
 * @returns {string} base64(iv | tag | ciphertext)
 */
export function encrypt(text) {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALG, key(), iv)
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

/**
 * 解不开就抛错，绝不返回空串 —— 静默吞错会让"密钥丢了"看起来像"没配置"。
 * @param {string} payload
 * @returns {string}
 */
export function decrypt(payload) {
  if (typeof payload !== 'string' || !payload.trim()) throw new Error('集成密钥密文为空')
  // Buffer.from 会静默忽略非法 base64 字符；先严格校验，篡改必须报错
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    throw new Error('集成密钥密文格式无效')
  }
  const buf = Buffer.from(payload, 'base64')
  if (buf.length <= IV_BYTES + TAG_BYTES) throw new Error('集成密钥密文格式无效')

  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buf.subarray(IV_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv(ALG, key(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('集成密钥解密失败（APP_SECRET 是否变化？）')
  }
}

/** @param {Record<string, unknown>} obj */
export const encryptJson = (obj) => encrypt(JSON.stringify(obj))

/**
 * @param {string} payload
 * @returns {Record<string, string>}
 */
export function decryptJson(payload) {
  const parsed = JSON.parse(decrypt(payload))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('集成密钥内容必须是对象')
  return parsed
}
