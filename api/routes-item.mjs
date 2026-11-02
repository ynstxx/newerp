import * as item from './item.mjs'

/**
 * 切片 · 主数据与库存（item）。路径不带 /t/{slug} 前缀 —— 租户中间件已剥掉。
 * @param {any} router
 */
export function register(router) {
  router.get('/api/items', item.listItems)
  router.post('/api/items', item.createItem)
  router.get('/api/items/:id', item.getItem)
  router.patch('/api/items/:id', item.updateItem)
  router.del('/api/items/:id', item.deleteItem)

  router.get('/api/warehouses', item.listWarehouses)
  router.post('/api/warehouses', item.createWarehouse)
  router.get('/api/warehouses/:id', item.getWarehouse)
  router.patch('/api/warehouses/:id', item.updateWarehouse)
  router.del('/api/warehouses/:id', item.deleteWarehouse)

  router.get('/api/price-books', item.listPrices)
  router.post('/api/price-books', item.createPrice)
  router.get('/api/price-books/:id', item.getPrice)
  router.patch('/api/price-books/:id', item.updatePrice)
  router.del('/api/price-books/:id', item.deletePrice)

  router.get('/api/stock/moves', item.listMoves)
  router.post('/api/stock/moves', item.createMove)
  router.get('/api/stock/balances', item.listBalances)
  router.get('/api/stock/sn/:sn', item.traceSn)
}
