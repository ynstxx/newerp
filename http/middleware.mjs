import { randomUUID } from 'node:crypto'
import { HttpError, errors, sendError } from './errors.mjs'

/**
 * @typedef {(ctx: any, next: () => Promise<void>) => Promise<void>} Middleware
 */

/**
 * 洋葱模型。next() 只允许调用一次。
 * @param {Middleware[]} mws
 */
export function compose(mws) {
  /** @param {any} ctx */
  return async function run(ctx) {
    let last = -1
    /** @param {number} i */
    const step = async (i) => {
      if (i <= last) throw new Error('next() called twice')
      last = i
      const mw = mws[i]
      if (mw) await mw(ctx, () => step(i + 1))
    }
    await step(0)
  }
}

/**
 * 驱动错误码收敛：唯一键/外键冲突不该冒成 500。
 * PG: 23505 唯一冲突 / 23503 外键不存在；MySQL: 1062 / 1452（以及 ER_* 码）。
 * 并发撞唯一键（两个请求同时算出同一个 code 或版本号）时，用户该看到 409，不是"服务器繁忙"。
 * @param {any} err
 * @returns {any}
 */
function mapDriverError(err) {
  const code = String(err?.code ?? '')
  const errno = Number(err?.errno ?? 0)
  if (code === '23505' || errno === 1062 || code === 'ER_DUP_ENTRY') {
    return new HttpError(errors.conflict, { reason: '同一记录已存在（可能是并发提交），请重试' })
  }
  if (code === '23503' || errno === 1452 || code === 'ER_NO_REFERENCED_ROW_2') {
    return new HttpError(errors.badRequest, { reason: '引用的记录不存在' })
  }
  return errors.internal
}

/** @type {Middleware} */
export async function recover(ctx, next) {
  try {
    await next()
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(`[${ctx.requestId}] unhandled`, err)
    const e = /** @type {any} */ (err)
    sendError(ctx.res, err instanceof HttpError ? e : mapDriverError(e), ctx.requestId, e?.details)
  }
}

/** @type {Middleware} */
export async function requestId(ctx, next) {
  ctx.requestId = randomUUID()
  ctx.res.setHeader('x-request-id', ctx.requestId)
  await next()
}

/** @type {Middleware} */
export async function log(ctx, next) {
  await next()
  const ms = Date.now() - ctx.startedAt
  console.log(`${ctx.req.method} ${ctx.url.pathname} ${ctx.res.statusCode} ${ms}ms ${ctx.requestId}`)
}
