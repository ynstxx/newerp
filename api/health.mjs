import { config } from '../config.mjs'
import { sendJson } from '../http/context.mjs'
import { q } from '../db/index.mjs'

const bootAt = Date.now()

/**
 * 健康检查：真的去问一次库，不是只看自己活着。
 * 返回 200 恒定（容器/负载均衡靠 body.ok 判断），db 只有 up / down 两态。
 * ai / notify_worker / last_sync 等模块落地后再往这里加字段（DESIGN §13）。
 * @type {import('../http/router.mjs').Handler}
 */
export async function health(ctx) {
  let db = 'down'
  try {
    await q(ctx, 'SELECT 1 AS ok', [])
    db = 'up'
  } catch {
    // 健康检查每几秒一次，库挂了不该把日志刷满；要看原因查启动日志
  }
  sendJson(ctx.res, 200, {
    ok: db === 'up',
    db,
    version: config.version,
    env: config.env,
    uptime: Math.round((Date.now() - bootAt) / 1000),
    requestId: ctx.requestId,
  })
}
