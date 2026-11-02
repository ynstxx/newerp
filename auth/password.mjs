import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(/** @type {any} */ (scrypt))

// DESIGN §5：scrypt(N=16384, r=8, p=1) + 独立 salt + timingSafeEqual
const PARAMS = { N: 16384, r: 8, p: 1 }
const KEYLEN = 64

/**
 * @param {string} password
 * @returns {Promise<{ hash: string, salt: string }>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex')
  const hash = /** @type {Buffer} */ (await scryptAsync(password, salt, KEYLEN, PARAMS))
  return { hash: hash.toString('hex'), salt }
}

/**
 * 恒定时间比较；任何异常都返回 false，不向外泄漏原因
 * @param {string} password
 * @param {string} hash
 * @param {string} salt
 */
export async function verifyPassword(password, hash, salt) {
  const expected = Buffer.from(hash, 'hex')
  const actual = /** @type {Buffer} */ (await scryptAsync(password, salt, expected.length, PARAMS))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
