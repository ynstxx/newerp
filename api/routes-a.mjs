import * as opportunity from './opportunity.mjs'
import * as project from './project.mjs'

/**
 * 切片 A 路由（商机 + 立项）。挂载方：cmd/server.mjs 或 test/helpers.mjs 的 makeApp(register)。
 * 路径不带 /t/{slug} 前缀 —— 租户中间件已经把它剥掉。
 * @param {any} router
 */
export function register(router) {
  router.post('/api/opportunities', opportunity.create)
  router.get('/api/opportunities', opportunity.list)
  router.get('/api/opportunities/:id', opportunity.get)
  router.patch('/api/opportunities/:id', opportunity.update)
  router.post('/api/opportunities/:id/advance', opportunity.advance)

  router.get('/api/projects', project.list)
  router.get('/api/projects/:id', project.get)
  router.patch('/api/projects/:id', project.update)
  router.post('/api/projects/:id/advance', project.advance)
  router.get('/api/projects/:id/stages', project.stages)
}
