import * as config from './config.mjs'

/**
 * 租户级系统设置（只读列表 + 单项更新）。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/configs', config.list)
  router.put('/api/configs/:key', config.put)
}
