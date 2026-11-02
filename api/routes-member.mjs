import * as member from './member.mjs'

/**
 * 成员通讯录（只读）。路径不带 /t/{slug} 前缀（租户中间件已剥掉）。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/members', member.list)
}
