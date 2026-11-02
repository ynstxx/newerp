# AI 层切片（M6）

> 契约来源：`docs/DESIGN.md` §12 / §15 M6。本文只记录本切片的取舍与合并注意事项。

## 表（`schema/ai.mjs`）

| 表 | 说明 |
|---|---|
| `ai_settings` | 租户级 LLM 配置；`api_key` 为 aes-256-gcm 密文，永不回显 |
| `ai_draft` | 草稿 + 状态机 + `applied_ref_*`（幂等落库凭据） |
| `ai_trace` | 每次 LLM 调用的 token / 耗时 / tool_calls |

正式迁移由主线统一生成（切片内的 `990_ai` 只用于本地测试，已清理）。
合并后执行 `node cmd/migrate.mjs gen 0008_ai`。

## write 工具为什么结构上没有 run

`svc/ai_tools.mjs` 的 `registerTool()` 在注册时硬校验：

- `level='write'` 且对象上存在 `run` → 直接抛错；write 必须有 `draft()`
- `level='read'` 且对象上存在 `draft` → 直接抛错；read 必须有 `run()`
- 注册后 `Object.freeze()`，之后也无法补挂 `run`

因此 `create_party` 只有 `draft(ctx,args) -> {payload, preview}`。
`makeDraft()` 只返回 payload，不写业务表；`callRead()` 对 write 工具直接 400。
测试里同时断言 `'run' in writeTool === false` 与"注册带 run 的 write 工具会抛错"。

唯一落库通道是 `svc/ai_draft.apply()`：人审通过后，在事务里重新跑一遍
`draft()` 做二次校验，再调用与人工**完全相同**的 `svc/party.createParty`。

## 取舍

- **审批复用 §9**：`chat` 创建 `ai_draft(status=pending)` 后立刻
  `approval.submit({docType:'ai_draft'})`；审批结果通过 `approval_hooks`
  在同一事务里回写 `approved/rejected`。没有第二套审批。
- **幂等**：apply 事务内 `SELECT ... FOR UPDATE` 锁草稿；`applied` 状态重复 apply
  返回 200 + 原 `applied_ref`，不会重复建单。并发请求同样串行化。
- **失败可重试**：业务函数报错 → 事务回滚 → 另一个事务把草稿改为
  `status='failed'` + 可读 `error`；修好环境后可从 `failed` 再次 apply。
- **离线降级**：`enabled=false` / 无 `base_url` / 无 `api_key` → 功能入口 503，
  原因写明；超配额 429。`GET/PUT /api/ai/settings` 保持可访问，否则无法重新启用。
  跨租户对象请求先查存在性（404），再判断离线（503），避免泄露存在性。
- **不做流式 SSE**、不发通知、不注册 `create_purchase_order`
  （采购切片合并后在 `ai_tools.mjs` 补一个 `draft()` 即可）。
- `ai_trace.cost_micros` 暂记 0：供应商/模型单价差异太大，等有成本核算需求时
  在 `ai_settings` 加单价字段再计算。
- `ai_trace` 每次调用都写；配额累加与 trace 同一事务。

## 端点

```
GET  /api/ai/settings          PUT /api/ai/settings
POST /api/ai/chat
GET  /api/ai/drafts            GET /api/ai/drafts/:id
POST /api/ai/drafts/:id/approve|reject|apply
GET  /api/ai/traces
```
