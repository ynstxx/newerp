import * as ai from './ai.mjs'

/**
 * AI 域路由。挂载方：cmd/server.mjs（自动发现 api/routes-*.mjs）+ test/helpers.mjs 的 makeApp()。
 * 路径不带 /t/{slug} 前缀 —— 租户中间件已经把它剥掉。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/ai/settings', ai.getSettings)
  router.put('/api/ai/settings', ai.putSettings)

  router.post('/api/ai/chat', ai.chat)

  router.get('/api/ai/drafts', ai.listDrafts)
  router.get('/api/ai/drafts/:id', ai.getDraft)
  router.post('/api/ai/drafts/:id/approve', ai.approve)
  router.post('/api/ai/drafts/:id/reject', ai.reject)
  router.post('/api/ai/drafts/:id/apply', ai.apply)

  router.get('/api/ai/traces', ai.listTraces)
}
