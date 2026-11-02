import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { config } from '../config.mjs'

/**
 * 算术人机校验：无状态（HMAC 签名 token），不落表、不引第三方。
 * 只挡脚本批量注册，不挡真人 —— 够用就停。
 * ponytail: 只有 math 一种；要 Turnstile 时在这里加一个 provider 分支
 */
const TTL_MS = 10 * 60 * 1000

/** @param {string} payload */
const sign = (payload) => createHmac('sha256', config.secret).update(payload).digest('base64url')

/** @returns {{ token: string, question: string }} */
export function issue() {
  const a = randomInt(1, 10)
  const b = randomInt(1, 10)
  const payload = `${a}+${b}.${Date.now()}`
  return { token: `${payload}.${sign(payload)}`, question: `${a} + ${b} = ?` }
}

/**
 * @param {string | undefined} token
 * @param {string | number | undefined} answer
 */
export function verify(token, answer) {
  if (!token || answer === undefined || answer === null) return false
  const parts = String(token).split('.')
  if (parts.length !== 3) return false
  const [ab, ts, sig] = parts
  const payload = `${ab}.${ts}`
  const expect = Buffer.from(sign(payload))
  const got = Buffer.from(sig)
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) return false
  if (Date.now() - Number(ts) > TTL_MS) return false
  const [a, b] = ab.split('+').map(Number)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  return Number(answer) === a + b
}
