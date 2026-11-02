import * as design from './design.mjs'
import * as requirement from './requirement.mjs'

/**
 * 切片 B · 需求 + 方案 BOM。
 * 路径不带 /t/{slug} 前缀（租户中间件已剥掉），由 cmd/server.mjs 之外的测试入口注入。
 * @param {any} router
 */
export function register(router) {
  router.post('/api/requirements', requirement.create)
  router.get('/api/requirements', requirement.list)
  router.get('/api/requirements/:id', requirement.get)
  router.patch('/api/requirements/:id', requirement.update)
  router.post('/api/requirements/:id/advance', requirement.advance)

  router.post('/api/design-docs', design.create)
  router.get('/api/design-docs', design.list)
  router.get('/api/design-docs/:id', design.get)
  router.patch('/api/design-docs/:id', design.update)
  router.post('/api/design-docs/:id/advance', design.advance)
}
