import * as meta from './meta.mjs'

/**
 * 元数据（字典）。路径不带 /t/{slug} 前缀（租户中间件已剥掉）。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/meta/dicts', meta.dicts)
}
