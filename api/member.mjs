import { needUser } from '../auth/perm.mjs'
import { sendJson } from '../http/context.mjs'
import * as membership from '../store/membership.mjs'

/**
 * 本公司成员清单。界面上「负责人 / 项目经理」要显示姓名，不能显示 uuid。
 * 只要求登录 + 属于该公司（租户中间件已经校验过），不再额外要权限点 ——
 * 这是内部通讯录，任何成员看同事姓名是合理的。
 * @type {import('../http/router.mjs').Handler}
 */
export async function list(ctx) {
  needUser(ctx)
  const rows = await membership.listMembers(ctx)
  sendJson(ctx.res, 200, {
    items: rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      email: r.email,
    })),
  })
}
