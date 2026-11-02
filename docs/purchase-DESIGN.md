# 采购与财务（purchase）切片设计取舍

> 对应 DESIGN §7.2「采购分包 / 商务财务」、§15 M4（唯一验收点：项目毛利报表与手工核算一致）。
> 表：`schema/purchase.mjs`；业务：`svc/purchase.mjs`；SQL：`store/purchase.mjs`；HTTP：`api/purchase.mjs` + `api/routes-purchase.mjs`。

## 1. 金额与数量

一律 `money`（numeric(18,2) / decimal(18,2)），应用侧用 `http/money.mjs` 按「分」整数算：

- 行金额 = `mulCents(centsOf(qty), centsOf(price))`，1.005 → 101 分（half-up）。
- PO 金额 = 行金额之和，**客户端不能传 amount**（`only()` 白名单直接 400）。
- 毛利 `revenue/cost/gross` 都由分整数算出，`grossRate` 保留 6 位小数；合同 0 时返回 `null`。

## 2. 成本归集时点（最容易吵的地方）

| 事件 | 台账 | 成本 `cost_line` |
|---|---|---|
| PO 审批通过 | `ap_ledger +PO.amount` | **不记**（只是应付承诺） |
| 收货（grn_line） | — | `+收货数量 × PO 单价`，`ref_type=goods_receipt` |
| 分包合同审批通过 | `ap_ledger +sub.amount` | 不记 |
| 分包进度款审批通过 | —（已在应付里） | `+进度款`，`ref_type=subcontract_progress` |
| 销项发票 | `ar_ledger +amount` | 不记 |
| 收款 / 付款 | `ar/ap_ledger -amount` | 不记 |

理由：PO 审批只是承诺，收货才是成本发生；两边都记会重复计算。这样「一份 PO 分三次收货」也天然正确。

## 3. 应收应付

- 台账只增不改：正数=新债权/债务，负数=核销。余额 = `SUM(amount)`，与手工账本同构。
- `ar_ledger` 两个来源：`POST /api/ar-ledger`（合同→应收）与销项发票；`ap_ledger` 来源：PO 审批、分包审批、进项发票。
- 收付款前用台账余额做校验，超额 **409** 并返回 `outstanding`。

## 4. 状态机与审批

- PO：`draft → pending → approved | rejected`；`rejected → pending` 可重提；`approved → closed`。
- 分包同上；进度款 `draft → pending → approved | rejected`。
- 提交审批与单据状态**同一事务**（`withTx` 内调 `approval.submit`），不会出现「单子 draft、审批在途」。
- 审批回调在 `approval.decide` 的事务内执行：通过/驳回时改单据状态，并写应付/成本。
- 收货不要求审批回调里做任何事，只认 PO 的 `approved` 状态。

## 5. 明确没做

- 财务凭证 / 总账科目 / 试算平衡
- 付款审批、银行对接、发票查验与税额（金额为价税合计，`tax_rate` 未建模）
- 通知（审批结果不推消息，按 OPEN-ISSUES #3 由通知切片统一接）
- 收付款核销的并发串行化（`SUM` 无法行锁；当前是「读余额-再插入」，极端并发可能同时通过校验。
  真要治时给 `party` 行加 `FOR UPDATE` 或加核销明细唯一键）

## 6. 主线合并注意

- 迁移由主线统一 `node cmd/migrate.mjs gen 0008_purchase` 生成，切片内不提交 `990_*.sql` 与 `schema/snapshot.json`。
- 本切片自建 `ar_ledger/ap_ledger/cost_line/invoice/payment`，DESIGN 里这几张表原属「商务财务」组；
  若未来有独立的财务切片，**只保留一处**建表与入账入口，否则毛利会出现双份成本。
- `svc/purchase.mjs` 在模块加载时调用 `approval_hooks.register()`，注册了 3 个 docType：
  `purchase_order` / `subcontract` / `subcontract_progress`。若别的切片也注册同名 docType，后加载者覆盖前者。
- 毛利只读 `project`（存在性）、`contract`（合同额）、`cost_line`（成本），没有改任何别域表。
