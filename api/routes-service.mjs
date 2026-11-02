import * as service from './service.mjs'

/**
 * M5 售后路由。路径不带 /t/{slug} 前缀（租户中间件已剥掉）。
 * cmd/server.mjs 自动发现 api/routes-*.mjs 并调 register(router)。
 * @param {any} router
 */
export function register(router) {
  // 服务合同
  router.get('/api/service-contracts', service.listContracts)
  router.post('/api/service-contracts', service.createContract)
  router.get('/api/service-contracts/:id', service.getContract)
  router.patch('/api/service-contracts/:id', service.updateContract)
  router.del('/api/service-contracts/:id', service.removeContract)

  // 工单
  router.get('/api/tickets', service.listTickets)
  router.post('/api/tickets', service.createTicket)
  router.get('/api/tickets/:id', service.getTicket)
  router.post('/api/tickets/:id/advance', service.advanceTicket)
  router.post('/api/tickets/:id/dispatch', service.dispatchTicket)
  router.post('/api/tickets/:id/pause', service.pauseTicket)
  router.post('/api/tickets/:id/resume', service.resumeTicket)
  router.post('/api/tickets/:id/satisfaction', service.addSatisfaction)
  router.get('/api/tickets/:id/spare-parts', service.listSpareParts)
  router.post('/api/tickets/:id/spare-parts', service.addSparePart)

  // SLA
  router.get('/api/sla/overdue', service.slaOverdue)

  // 巡检
  router.get('/api/maintenance-plans', service.listPlans)
  router.post('/api/maintenance-plans', service.createPlan)
  router.get('/api/maintenance-plans/:id', service.getPlan)
  router.patch('/api/maintenance-plans/:id', service.updatePlan)
  router.get('/api/maintenance-plans/:id/tasks', service.listTasks)
  router.post('/api/maintenance-plans/:id/tasks', service.createTask)
  router.post('/api/maintenance-tasks/:id/done', service.finishTask)
}
