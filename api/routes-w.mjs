import * as workbench from './workbench.mjs'

/**
 * 切片 W · 工作台首页聚合。路径不带 /t/{slug} 前缀（租户中间件已剥掉）。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/workbench', workbench.overview)
}
