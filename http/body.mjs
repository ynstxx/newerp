import { HttpError, errors } from './errors.mjs'

const MAX_BYTES = 1024 * 1024

/**
 * 严格 JSON body：只接受 application/json、限 1MB、拒绝非对象。
 * 未知字段在 handler 里按各接口的字段集校验（本模块不认识业务）。
 * @param {any} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(ctx) {
  const ctype = String(ctx.req.headers['content-type'] ?? '')
  if (!ctype.includes('application/json')) {
    throw new HttpError(errors.badRequest, { reason: 'content-type 必须是 application/json' })
  }
  const declared = Number(ctx.req.headers['content-length'] ?? 0)
  if (declared > MAX_BYTES) throw new HttpError(errors.badRequest, { reason: 'body 超过 1MB' })

  /** @type {Buffer[]} */
  const chunks = []
  let size = 0
  for await (const chunk of ctx.req) {
    size += chunk.length
    if (size > MAX_BYTES) throw new HttpError(errors.badRequest, { reason: 'body 超过 1MB' })
    chunks.push(chunk)
  }
  if (!size) throw new HttpError(errors.badRequest, { reason: 'body 为空' })

  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(errors.badRequest, { reason: 'body 不是合法 JSON' })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(errors.badRequest, { reason: 'body 必须是 JSON 对象' })
  }
  return parsed
}

/**
 * 只取白名单字段，多余字段直接报错（挡住"偷偷传 tenantId"这类）
 * @param {Record<string, unknown>} body
 * @param {string[]} allowed
 */
export function only(body, allowed) {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k))
  if (extra.length) throw new HttpError(errors.badRequest, { reason: `未知字段 ${extra.join(', ')}` })
  return body
}
