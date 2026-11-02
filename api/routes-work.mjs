import * as work from './work.mjs'

/**
 * 施工域路由（M3）。挂载方：cmd/server.mjs 自动发现 routes-*.mjs；测试走 makeApp() 自动注册。
 * 路径不带 /t/{slug} 前缀 —— 租户中间件已经把它剥掉。
 * @param {any} router
 */
export function register(router) {
  // 施工计划 / 任务 / 进度
  router.get('/api/work-plans', work.listPlans)
  router.post('/api/work-plans', work.createPlan)
  router.get('/api/work-plans/:id', work.getPlan)
  router.patch('/api/work-plans/:id', work.updatePlan)

  router.get('/api/work-tasks', work.listTasks)
  router.post('/api/work-tasks', work.createTask)
  router.get('/api/work-tasks/:id', work.getTask)
  router.patch('/api/work-tasks/:id', work.updateTask)
  router.post('/api/work-tasks/:id/advance', work.advanceTask)

  router.get('/api/progress-logs', work.listProgressLogs)
  router.post('/api/progress-logs', work.createProgressLog)

  // 领料（审批 → 出库）
  router.get('/api/material-issues', work.listMaterialIssues)
  router.post('/api/material-issues', work.createMaterialIssue)
  router.get('/api/material-issues/:id', work.getMaterialIssue)
  router.patch('/api/material-issues/:id', work.updateMaterialIssue)
  router.post('/api/material-issues/:id/submit', work.submitMaterialIssue)

  // 变更签证（审批 → 影响合同额）
  router.get('/api/change-orders', work.listChangeOrders)
  router.post('/api/change-orders', work.createChangeOrder)
  router.get('/api/change-orders/:id', work.getChangeOrder)
  router.patch('/api/change-orders/:id', work.updateChangeOrder)
  router.post('/api/change-orders/:id/submit', work.submitChangeOrder)

  // 验收
  router.get('/api/acceptances', work.listAcceptances)
  router.post('/api/acceptances', work.createAcceptance)
  router.get('/api/acceptances/:id', work.getAcceptance)
  router.patch('/api/acceptances/:id', work.updateAcceptance)
  router.post('/api/acceptances/:id/advance', work.concludeAcceptance)

  // 工时 / 现场记录
  router.get('/api/labor-hours', work.listLaborHours)
  router.post('/api/labor-hours', work.createLaborHour)
  router.get('/api/labor-hours/:id', work.getLaborHour)
  router.patch('/api/labor-hours/:id', work.updateLaborHour)
  router.del('/api/labor-hours/:id', work.deleteLaborHour)

  router.get('/api/site-records', work.listSiteRecords)
  router.post('/api/site-records', work.createSiteRecord)
  router.get('/api/site-records/:id', work.getSiteRecord)
  router.patch('/api/site-records/:id', work.updateSiteRecord)
  router.del('/api/site-records/:id', work.deleteSiteRecord)
}
