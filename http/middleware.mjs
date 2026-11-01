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

/** @type {Middleware} */
export async function recover(ctx, next) {
  try {
    await next()
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(`[${ctx.requestId}] unhandled`, err)
    const e = /** @type {any} */ (err)
    sendError(ctx.res, err instanceof HttpError ? e : errors.internal, ctx.requestId, e?.details)
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
