import * as quotation from './quotation.mjs'

/**
 * C 切片（报价）路由。路径不带 /t/{slug} 前缀 —— 租户中间件已经把它剥掉了。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/quotations', quotation.list)
  router.post('/api/quotations', quotation.create)
  router.get('/api/quotations/:id', quotation.get)
  router.post('/api/quotations/:id/advance', quotation.advance)
}
