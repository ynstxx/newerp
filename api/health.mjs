import { config } from '../config.mjs'
import { sendJson } from '../http/context.mjs'

const bootAt = Date.now()

/** @type {import('../http/router.mjs').Handler} */
export function health(ctx) {
  sendJson(ctx.res, 200, {
    ok: true,
    version: config.version,
    env: config.env,
    uptime: Math.round((Date.now() - bootAt) / 1000),
    requestId: ctx.requestId,
  })
}
