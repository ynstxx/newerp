/**
 * 主数据 + 库存（DESIGN §7.2 的「主数据」组）。
 *
 * 这一域只提供记账能力：采购单/领料单由别的切片负责，它们只调 svc/stock.applyMove。
 * 数量与单价一律用 `money` 物理类型（numeric(18,2) / decimal(18,2)），
 * 应用侧用 http/money.mjs 按「分」做整数运算，避免浮点误差。
 *
 * stock_move 只增不改；余额由 stock_bin 单独维护（同一事务内更新）。
 * stock_move.sn_list 是序列号索引用的冗余串（形如 |SN1|SN2|），
 * 只为反查流水服务 —— 数据库不做 JSON 路径查询。
 */

export const tables = [
  {
    name: 'item',
    tenant: true,
    cols: [
      { n: 'code', t: 'code', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'spec', t: 'code' },
      { n: 'category', t: 'code' },
      { n: 'base_uom', t: 'code', notNull: true },
      { n: 'status', t: 'code', notNull: true },
      { n: 'version', t: 'int', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['name'], ['category', 'status'], ['created_at', 'id']],
  },
  {
    name: 'item_uom',
    tenant: true,
    cols: [
      { n: 'item_id', t: 'uuid', notNull: true },
      { n: 'uom', t: 'code', notNull: true },
      { n: 'ratio', t: 'money', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    uniq: [['item_id', 'uom']],
    index: [['item_id']],
    fk: [{ cols: ['item_id'], ref: 'item' }],
  },
  {
    name: 'warehouse',
    tenant: true,
    cols: [
      { n: 'code', t: 'code', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'status', t: 'code', notNull: true },
      { n: 'version', t: 'int', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['created_at', 'id']],
  },
  {
    name: 'stock_bin',
    tenant: true,
    cols: [
      { n: 'warehouse_id', t: 'uuid', notNull: true },
      { n: 'item_id', t: 'uuid', notNull: true },
      { n: 'qty', t: 'money', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['warehouse_id', 'item_id']],
    index: [['item_id', 'warehouse_id'], ['created_at', 'id']],
    fk: [
      { cols: ['warehouse_id'], ref: 'warehouse' },
      { cols: ['item_id'], ref: 'item' },
    ],
  },
  {
    name: 'stock_move',
    tenant: true,
    cols: [
      { n: 'warehouse_id', t: 'uuid', notNull: true },
      { n: 'item_id', t: 'uuid', notNull: true },
      { n: 'qty', t: 'money', notNull: true },
      { n: 'dir', t: 'code', notNull: true },
      { n: 'move_type', t: 'code', notNull: true },
      { n: 'ref_type', t: 'code' },
      { n: 'ref_id', t: 'code' },
      // |SN1|SN2| —— 只给 snTrace 的 LIKE 反查用，不存 JSON
      { n: 'sn_list', t: 'text' },
      { n: 'unit_cost', t: 'money' },
      { n: 'note', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
    ],
    index: [
      ['warehouse_id', 'item_id', 'at'],
      ['ref_type', 'ref_id'],
      ['at', 'id'],
      ['at'],
    ],
    fk: [
      { cols: ['warehouse_id'], ref: 'warehouse' },
      { cols: ['item_id'], ref: 'item' },
    ],
  },
  {
    name: 'item_sn',
    tenant: true,
    cols: [
      { n: 'item_id', t: 'uuid', notNull: true },
      { n: 'sn', t: 'code', notNull: true },
      { n: 'warehouse_id', t: 'uuid', notNull: true },
      { n: 'status', t: 'code', notNull: true },
      { n: 'ref_type', t: 'code' },
      { n: 'ref_id', t: 'code' },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    uniq: [['sn']],
    index: [['item_id', 'warehouse_id'], ['created_at', 'id']],
    fk: [
      { cols: ['item_id'], ref: 'item' },
      { cols: ['warehouse_id'], ref: 'warehouse' },
    ],
  },
  {
    name: 'price_book',
    tenant: true,
    cols: [
      { n: 'item_id', t: 'uuid', notNull: true },
      { n: 'price_type', t: 'code', notNull: true },
      { n: 'price', t: 'money', notNull: true },
      { n: 'valid_from', t: 'time' },
      { n: 'valid_to', t: 'time' },
      { n: 'version', t: 'int', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    index: [['item_id', 'price_type', 'valid_from'], ['created_at', 'id']],
    fk: [{ cols: ['item_id'], ref: 'item' }],
  },
]
