import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { config } from '../config.mjs'

/**
 * AI api_key 落库前的唯一加解密入口（DESIGN §11.5 / §12.3）。
 * AES-256-GCM：随机 12 字节 IV + 16 字节 auth tag，输出 base64(iv|tag|ciphertext)。
 * 密钥由 APP_SECRET 派生 —— 换 APP_SECRET 后旧密文解不开是预期行为。
 *
 * 与 integration_crypto 同算法但不同派生前缀：两个域的密文不能互相解。
 */

const ALG = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

const key = () => createHash('sha256').update(`newerp:ai:${config.secret}`, 'utf8').digest()

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
  if (typeof payload !== 'string' || !payload.trim()) throw new Error('AI 密钥密文为空')
  // Buffer.from 会静默忽略非法 base64 字符；先严格校验，篡改必须报错
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    throw new Error('AI 密钥密文格式无效')
  }
  const buf = Buffer.from(payload, 'base64')
  if (buf.length <= IV_BYTES + TAG_BYTES) throw new Error('AI 密钥密文格式无效')

  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buf.subarray(IV_BYTES + TAG_BYTES)
  try {
    const decipher = createDecipheriv(ALG, key(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('AI 密钥解密失败（APP_SECRET 是否变化？）')
  }
}
