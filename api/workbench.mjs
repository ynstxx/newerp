import { need, PERM } from '../auth/perm.mjs'
import { sendJson } from '../http/context.mjs'
import * as svc from '../svc/workbench.mjs'

/**
 * 工作台首页聚合（只读）。挂载方：cmd/server.mjs 或 test/helpers.mjs 的 makeApp(register)。
 * @type {import('../http/router.mjs').Handler}
 */
export async function overview(ctx) {
  need(ctx, PERM.projectView)
  sendJson(ctx.res, 200, await svc.overview(ctx))
}
