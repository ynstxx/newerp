# item 域设计（主数据 + 库存）

范围：物料/仓库/库位余额/库存流水/序列号/价格本。
**不做**采购单、领料单 —— 那些切片只调 `svc/stock.applyMove` 记账。

## 表与实现取舍

| 表 | 说明 |
|---|---|
| `item` / `item_uom` | `uniq(tenant_id, code)`；UOM 比率为相对基本单位的换算率 |
| `warehouse` | `uniq(tenant_id, code)` |
| `stock_bin` | 余额表，`uniq(warehouse_id, item_id)`；每 (仓库,物料) 只有一行 |
| `stock_move` | **只增不改**的流水；列表按 `at` 游标分页 |
| `item_sn` | 一 SN 一行，`uniq(sn)`；入库登记 `in_stock`，出库改 `issued` |
| `price_book` | 价格类型 purchase/sale/cost，有效期可空 |

在题面列出的字段之外只加了三类列，都是实现必需而非业务扩张：

* `version` + `created_at/updated_at`：乐观锁、审计、游标分页（`party` 等域同款）。
* `stock_move.sn_list`：`|SN1|SN2|` 形式的冗余串，供 `snTrace` 用 `LIKE` 反查。
  没做 JSON 路径查询（DESIGN §6.2 禁止），也没有为 SN 另建事件表。
  SN 允许 `_`/`%`，LIKE 前显式转义并用 `ESCAPE '!'`，两库一致。

## 数量与金额

`qty`、`unit_cost`、`price`、`ratio` 全部用 `money` 物理类型（`numeric(18,2)` / `decimal(18,2)`）。
应用侧一律走 `http/money.mjs` 的 `centsOf/moneyOf`，按「分」整数运算，禁止浮点。

## stock_bin 的并发写法（关键）

`applyMove` 在**同一事务**里：

1. 先 `SELECT id FROM item WHERE $t AND id = $1 FOR UPDATE` 锁物料行 ——
   同一物料的并发出入库被串行化（不同物料互不阻塞）。
2. 入库：`UPDATE stock_bin SET qty = qty + $1 WHERE $t AND warehouse_id = $2 AND item_id = $3`；
   影响 0 行才 `INSERT`。**不用** `ON CONFLICT` / `ON DUPLICATE KEY`（DESIGN §6.2 禁 upsert）。
3. 出库：`UPDATE ... SET qty = qty - $1 ... AND qty >= $1`；影响 0 行就查 `available`
   并抛 409，余额永远不会变成负数。
4. 写 `stock_move` + 登记/核销 `item_sn` + 一条 `audit_log`。

步骤 1 的行锁是步骤 2「UPDATE 0 行再 INSERT」在并发下不撞 `uniq(warehouse_id,item_id)` 的前提；
没有它，两个事务会同时 UPDATE 0 行再同时 INSERT。测试同时覆盖了连续两次与 `Promise.all` 并发两次。
