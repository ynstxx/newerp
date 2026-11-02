import * as integration from './integration.mjs'

/**
 * 切片 integration · 钉钉/企微组织同步、扫码登录、群机器人推送。
 * 业务路径不带 /t/{slug} 前缀（租户中间件已剥掉）；OAuth 回调是全局路径例外。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/integrations', integration.list)
  router.post('/api/integrations', integration.create)
  router.put('/api/integrations/:id', integration.update)
  router.post('/api/integrations/:id/sync', integration.sync)
  router.get('/api/integrations/:id/logs', integration.logs)
  router.get('/api/integrations/:id/auth-url', integration.authUrl)

  // 注意：这是全局路径，不带 /t/{slug}；租户靠 state 参数携带
  router.get('/api/auth/oauth/:provider/callback', integration.oauthCallback)
}
