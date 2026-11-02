import { HttpError, errors } from './errors.mjs'

/**
 * 声明式校验。只认识的类型够用就停，不做嵌套结构 DSL。
 * @typedef {object} Field
 * @property {'string'|'code'|'email'|'enum'|'int'|'bool'} type
 * @property {boolean} [required]
 * @property {number} [max]
 * @property {string[]} [values]
 */

const CODE = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 业务编码的唯一规范形式：全大写。
 * 不归一的话，PG（COLLATE "C"，大小写敏感）会放 ABC 与 abc 共存，
 * MySQL（utf8mb4_0900_ai_ci）会当重复 —— 同一个业务编码规则两库不等价。
 * @param {unknown} s
 */
export const normCode = (s) => String(s ?? '').trim().toUpperCase()

/**
 * 全部字段走白名单：spec 里没有的键直接丢掉（未知字段由 http/body.only 先挡）。
 * @param {Record<string, unknown>} body
 * @param {Record<string, Field>} spec
 * @param {{ partial?: boolean }} [opts] partial = 只有传了的字段才校验并返回
 */
export function validate(body, spec, opts = {}) {
  /** @type {Record<string, unknown>} */
  const out = {}
  /** @type {Record<string, string>} */
  const bad = {}

  for (const [key, f] of Object.entries(spec)) {
    const raw = body[key]
    const empty = raw === undefined || raw === null || raw === ''
    if (empty) {
      if (f.required && !opts.partial) bad[key] = 'required'
      continue
    }

    switch (f.type) {
      case 'string':
      case 'code':
      case 'email': {
        if (typeof raw !== 'string') {
          bad[key] = 'type'
          break
        }
        const v = raw.trim()
        if (f.type === 'code' && !CODE.test(v)) {
          bad[key] = 'code'
          break
        }
        if (f.type === 'email' && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v)) {
          bad[key] = 'email'
          break
        }
        if (f.max && v.length > f.max) {
          bad[key] = `max:${f.max}`
          break
        }
        out[key] = v
        break
      }
      case 'enum': {
        const v = String(raw)
        if (!f.values?.includes(v)) {
          bad[key] = `enum:${f.values?.join('|')}`
          break
        }
        out[key] = v
        break
      }
      case 'int': {
        const n = Number(raw)
        if (!Number.isInteger(n)) {
          bad[key] = 'type'
          break
        }
        out[key] = n
        break
      }
      case 'bool': {
        if (typeof raw !== 'boolean') {
          bad[key] = 'type'
          break
        }
        out[key] = raw
        break
      }
    }
  }

  if (Object.keys(bad).length) throw new HttpError(errors.badRequest, { fields: bad })
  return out
}
