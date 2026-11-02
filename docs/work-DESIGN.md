# 施工域（M3）设计取舍

表：`work_plan` · `work_task` · `progress_log` · `material_issue` · `material_issue_line` ·
`change_order` · `acceptance` · `labor_hour` · `site_record`（`schema/work.mjs`）。

## 1. 项目状态机延长（`svc/project.mjs`）

```
draft → approved → designing → quoting → signed
signed → constructing → pending_acceptance → warranty → closed
                                        ↘ terminated（任意阶段旁路，除终态）
pending_acceptance → constructing（验收返工，允许回退一格）
```

- `PROJECT_TRANSITIONS` 仍是唯一真源；`toApi.allowed` 让 API / 前端按钮自动跟上。
- `signed` 仍只能由合同签署联动（`advanceProject` 里显式拦住手工置 signed）。
- 签约后字段冻结（`FROZEN_STATUSES`），只能走状态机。
- 整体验收通过 → `advanceProject(tx, projectId, {to:'pending_acceptance'})`，
  不重复实现状态迁移，也不裸写 `UPDATE status`。

## 2. 领料 + 审批钩子（`svc/material_issue.mjs`）

- `draft → pending →(审批)→ issued`；失败分支 `pending → failed`（带 `error_message`），
  拒绝 `pending → rejected`。
- 审批通过后 hook 调 `stock.applyMove` 出库，**库存不足不吞**：
  1. hook 先把 `material_issue` 落 `failed` 并写 `error_message`，然后重新抛原始 409；
  2. `svc/approval.mjs` 的 `decide()` 捕获钩子异常，**不让事务回滚**，把
     `approval_instance` 落 `failed` + `approval_event(action='failed', comment=原因)`，
     事务提交后再把错误抛给调用方 —— 因此单据 failed、审批 failed、原因三处都可见。
- 多明细先按物料聚合（`qty` 用分累加），任一行失败就对已出库行发反向 `applyMove`
  （`moveType=material_issue_reverse`）补偿，保证「整单出库或一行不动」。
- 领料按数量出库，**不支持 SN**：反向补偿时 `applyMove` 的 SN 分支会与已登记冲突；
  SN 级领料留给售后/备件域（`docs/OPEN-ISSUES.md` 同类缺口）。

## 3. 变更签证（`svc/change_order.mjs`）

- `draft → pending →(审批)→ applied`，失败/拒绝占 `failed` / `rejected`。
- 通过后 `project.contract_amt += amount`，金额全走 `http/money.mjs`（分整数），
  负数变更（减项）允许，结果小于 0 则落 `failed`。
- 写 `audit_log(module='change_order', action='apply', before/after.contractAmt)`。
- 写 `project.contract_amt` 的 SQL 放在 `store/work.mjs`（`projectAddContractAmt`），
  没有改 `store/project.mjs`（M1 仍在用），并带 `version` 条件兜并发。

## 4. 验收（`svc/acceptance.mjs`）

- 验收项整存整取在 `acceptance.items`（`{name,result:pass|fail|na,note}`），禁 JSON 路径查询。
- `draft → passed | failed`。`type='overall'` 且 passed 才推进项目；`hidden` 不动项目。
- 验收出结论时项目不在 `constructing` 会 409 并带 `allowed`（不偷偷改状态）。

## 5. 计划 / 任务 / 进度 / 工时 / 现场记录

- 任务 `todo → doing → done`；`done` 强制 `progress=100`；`done` 是终态（返工另开任务）。
- 进度上报写 `progress_log` 并同事务把 `work_task.progress` 拉到最新值。
- 工时 / 现场记录是简单 CRUD（含 DELETE，`work:delete` 仅 owner）。

## 6. 端点

`/api/work-plans` `/api/work-tasks` `/api/work-tasks/:id/advance` `/api/progress-logs`
`/api/material-issues`(+`/:id/submit`) `/api/change-orders`(+`/:id/submit`)
`/api/acceptances`(+`/:id/advance`) `/api/labor-hours` `/api/site-records`

## 7. 合并时注意

- `svc/approval.mjs` 增加了**钩子失败 → 实例 failed** 的约定（`failed` 只由该路径写入，
  普通状态机仍不允许手工跳）。其它域的审批钩子如果也抛异常，会同样落 `failed`，这是有意为之。
- `material_issue.amount` 未传时按 `qty × unitCost` 现算；审批金额档以它为准。
- 正式迁移请用主线统一生成的 `NNNN_work.sql`（本切片只提交 schema，不提交 990 临时迁移）。
