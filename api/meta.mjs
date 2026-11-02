import { needUser } from '../auth/perm.mjs'
import { sendJson } from '../http/context.mjs'
import { allDicts } from '../svc/meta.mjs'

/**
 * 数据字典（只读）。前端拿它渲染下拉，不再自己硬编码枚举值。
 * 只要求登录：字典本身不含业务数据，也不区分租户。
 * @type {import('../http/router.mjs').Handler}
 */
export async function dicts(ctx) {
  needUser(ctx)
  sendJson(ctx.res, 200, allDicts())
}
