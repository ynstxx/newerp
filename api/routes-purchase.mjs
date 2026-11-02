import * as purchase from './purchase.mjs'

/**
 * 切片 · 采购与财务（purchase）。路径不带 /t/{slug} 前缀 —— 租户中间件已剥掉。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/purchase-orders', purchase.listPOs)
  router.post('/api/purchase-orders', purchase.createPO)
  router.get('/api/purchase-orders/:id', purchase.getPO)
  router.patch('/api/purchase-orders/:id', purchase.updatePO)
  router.post('/api/purchase-orders/:id/submit', purchase.submitPO)

  router.get('/api/goods-receipts', purchase.listReceipts)
  router.post('/api/goods-receipts', purchase.createReceipt)
  router.get('/api/goods-receipts/:id', purchase.getReceipt)

  router.get('/api/subcontracts', purchase.listSubcontracts)
  router.post('/api/subcontracts', purchase.createSubcontract)
  router.get('/api/subcontracts/:id', purchase.getSubcontract)
  router.post('/api/subcontracts/:id/submit', purchase.submitSubcontract)
  router.post('/api/subcontracts/:id/progress', purchase.createProgress)
  router.get('/api/subcontracts/:id/progress/:progressId', purchase.getProgress)
  router.post('/api/subcontracts/:id/progress/:progressId/submit', purchase.submitProgress)

  router.get('/api/invoices', purchase.listInvoices)
  router.post('/api/invoices', purchase.createInvoice)
  router.get('/api/invoices/:id', purchase.getInvoice)

  router.get('/api/payments', purchase.listPayments)
  router.post('/api/payments', purchase.createPayment)
  router.get('/api/payments/:id', purchase.getPayment)

  router.get('/api/ar-ledger', purchase.listAR)
  router.post('/api/ar-ledger', purchase.createAR)
  router.get('/api/ar-ledger/balance', purchase.arBalance)
  router.get('/api/ap-ledger', purchase.listAP)
  router.get('/api/ap-ledger/balance', purchase.apBalance)

  router.get('/api/cost-lines', purchase.listCosts)
  router.get('/api/projects/:id/profit', purchase.projectProfit)
}
