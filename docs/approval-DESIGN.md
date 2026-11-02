# 审批引擎切片（approval）

DESIGN §9 的落地记录。**只做有序多级 + 金额档**，不做并行分支 / 会签网关 / 条件表达式 /
图形设计器 / 子流程 / 定时器。

## 表

| 表 | 说明 |
|---|---|
| `approval_flow` | 流程定义；`steps` JSON 整存整取，`uniq(code)` |
| `approval_instance` | 审批单；`flow_snapshot` 是**提交时**的审批链快照 |
| `approval_task` | 每级任务；`uniq(instance_id, step_no, approver_user_id)` |
| `approval_event` | 只插不改的流水（submit/approve/reject/withdraw/delegate） |
| `org_dept` | 部门树；`manager_user_id` = 部门负责人，`parent_id` 向上走 |
| `org_dept_member` | 人 ↔ 部门归属；`manager` 型审批人靠它定位提交人的部门 |

`org_dept` / `org_dept_member` 是为解析 `approver_type='manager'` 而生。`org_membership`
属平台域（本切片不能改），因此人部门归属单独建表；主数据的组织架构模块落地后应由它写入，
本域只读。`manager` 解析：提交人所在部门的 `manager_user_id`，若就是提交人本人则沿
`parent_id` 继续向上；找不到 → **409**，绝不生成无人可批的单子。

## 选链（金额档）

- 金额比较一律走 `http/money.mjs` 的分/BigInt，`[min, max)` 半开区间，`null` = 无界。
- 金额落在哪一档 = **最高 applicable 的 step.no**；链路 = `no ≤ 它的全部级`（1..N）。
  例：`[{no:1, [0,100000)}, {no:2, [100000,∞)}]` → 8 万 1 级、12 万 2 级。
- 都不落档（例如高于所有 `max`）→ 退到「所有级都不带金额区间」的流程，用它的全部级。
- 仍没有 → **409**（无可用 flow 不静默放行）。

## 审批人

| `approver_type` | 解析 |
|---|---|
| `user` | `approver_ref` = 用户 id，必须是本公司 active 成员，否则 409 |
| `role` | `approver_ref` = 角色 code；`mode='any'` 建一条 `approver_user_id=NULL` 的占位任务，该角色任一人可认领；`mode='all'` 解析成每个成员一条 |
| `manager` | 沿 `org_dept` 向上找提交人的上级 |

`myTasks` 返回 `approver_user_id = 我` 的 pending 任务；role 占位任务按 `ctx.role.code` 与
快照里的 `approver_ref` 匹配后一并返回（`claimable: true`），`decide` 时把任务落成具体人。
注意：`GET` 不写库（占位行在提交时创建），角色成员后续变化靠这条匹配兜住。

## 状态机

```
instance: pending → approved | rejected | withdrawn
task:     pending → approved | rejected | delegated | skipped
```

用 `svc/transition.mjs` 的 `assertTransition`；非法跳转 409 且带 `allowed`。
`mode='all'` 在最后一个人批完才推进；`any` 一人通过后同级其余 pending → `skipped`。
`reject` / `withdraw` 会跳过实例所有 pending 任务。转办 = 原任务 `delegated` +
同一级给目标人新插一条 pending。

## 事务与副作用

- 所有写操作 `withTx` + 一条 `audit.insert`（module=`approval`）。
- 结束时的业务回调在**同一事务**里跑：`svc/approval_hooks.mjs` 的
  `register(docType, {onApproved, onRejected})`，回调签名 `(ctx, docType, docId, instance)`。
  业务域只注册，不关心链路。
- 通知（DESIGN §9.3 的「发通知给审批人」）留给 notify 域：本切片未接。

## 端点

```
GET    /api/approval/flows            approval:view
POST   /api/approval/flows            approval:config
GET    /api/approval/flows/:id        approval:view
PATCH  /api/approval/flows/:id        approval:config（带 version 乐观锁）
POST   /api/approvals                 提交（登录即可，业务域自己先做权限/状态校验）
GET    /api/approvals/my-tasks        我的待办
POST   /api/approvals/tasks/:id/decide    {action:'approve'|'reject', comment}
POST   /api/approvals/tasks/:id/delegate  {toUserId}
POST   /api/approvals/:id/withdraw       提交人撤回
GET    /api/approvals/:id/events         流水
```

样式约定：`doc_type` / 流程 `code` 统一 `normCode`（大写）后落库，避免 PG(C) 与
MySQL(ai_ci) 对大小写行为不一致。同一 `(doc_type, doc_id)` 已有 pending 实例时再提交 → 409。

## 已知取舍

- `steps` 的未知字段、空数组、重复 `no`、`min >= max` 都是 400（steps 是对象数组，
  `http/validate` 的 DSL 不表达数组，校验放在 `svc.normSteps`）。
- `approver_type='field'`（DESIGN §9.4 提到）**未实现**：需要知道业务单据的字段，
  属跨域耦合，等真实需求。
- `withdraw` 只允许提交人（403），跨租户一律 404。
- 主线合并注意：`org_dept` / `org_dept_member` 若与组织架构切片重名，需要合并成一份；
  `990_approval` 只是本切片自测用的临时迁移，正式迁移由主线统一生成。
