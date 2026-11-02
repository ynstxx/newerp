import * as notify from './notify.mjs'

/**
 * 通知中心路由。路径不带 /t/{slug} 前缀（租户中间件已剥掉）。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/notify/inbox', notify.inboxList)
  router.post('/api/notify/inbox/read-all', notify.inboxReadAll)
  router.post('/api/notify/inbox/:id/read', notify.inboxRead)

  router.get('/api/notify/channels', notify.channelList)
  router.post('/api/notify/channels', notify.channelCreate)
  router.put('/api/notify/channels/:id', notify.channelPut)

  router.get('/api/notify/templates', notify.templateList)
  router.post('/api/notify/templates', notify.templateCreate)
  router.put('/api/notify/templates/:id', notify.templatePut)

  router.post('/api/notify/test', notify.testSend)
}
