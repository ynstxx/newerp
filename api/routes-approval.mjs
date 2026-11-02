import * as approval from './approval.mjs'

/**
 * 审批域路由。挂载方：cmd/server.mjs（自动发现 api/routes-*.mjs）+ test/helpers.mjs 的 makeApp()。
 * 路径不带 /t/{slug} 前缀 —— 租户中间件已经把它剥掉。
 * @param {any} router
 */
export function register(router) {
  // 流程定义（approval:view / approval:config）
  router.get('/api/approval/flows', approval.listFlows)
  router.post('/api/approval/flows', approval.createFlow)
  router.get('/api/approval/flows/:id', approval.getFlow)
  router.patch('/api/approval/flows/:id', approval.updateFlow)

  // 执行侧
  router.post('/api/approvals', approval.submit)
  router.get('/api/approvals/my-tasks', approval.myTasks)
  router.post('/api/approvals/tasks/:id/decide', approval.decide)
  router.post('/api/approvals/tasks/:id/delegate', approval.delegate)
  router.post('/api/approvals/:id/withdraw', approval.withdraw)
  router.get('/api/approvals/:id/events', approval.events)
}
