import * as contract from './contract.mjs'

/**
 * 切片 D · 合同。路由总表在 cmd/server.mjs，本文件只导出 register，避免并行期抢改总表。
 * 路径不带 /t/{slug} 前缀（租户中间件已剥掉）。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/contracts', contract.list)
  router.post('/api/contracts', contract.create)
  router.get('/api/contracts/:id', contract.get)
  router.post('/api/contracts/:id/advance', contract.advance)
}
