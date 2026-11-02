# 前端并行契约（第 3 波）

> 你只做**页面文件**。菜单、路由、主题、组件都归主线 —— 这样 4 个人并行时零冲突。

## 0. 你只能新建这些文件

```
web/src/views/<你的页面>.vue        按下面分配的文件名，一个不多一个不少
web/src/i18n/<你的编号>.zh.json     你的全部文案
web/src/i18n/<你的编号>.en.json
web/src/format.js 之类的共享件不许改
```

**禁止修改**：`App.vue`、`AppShell.vue`、`main.js`、`api.js`、`state.js`、`i18n.js`、`theme.css`、
`components/PageTemplate.vue`、`package.json`、任何 `web/` 以外的文件、别人的视图和 i18n 文件。

菜单项和路由由主线加。你只需要保证**这些文件按名字导出默认组件**，能独立 build 通过。

## 1. 必读

- `web/src/views/ProjectListView.vue` —— **参考实现**，照它的结构写
- `web/src/components/PageTemplate.vue` —— 五槽骨架，必须用：
  `#search`（左上）`#actions`（右上）默认槽（中间表格/表单）`#hint`（左下）`#pager`（右下）
- `web/src/api.js`（`api.get/post/patch/del`、`fieldErrors`）、`web/src/format.js`、`web/src/state.js`
- `web/src/theme.css` —— 只用里面的 `--erp-*` 变量，**不要硬编码颜色**
- `docs/PARALLEL-CONTRACT.md` §2 —— 后端返回的约定（游标分页、allowed、409 语义）

## 2. 硬约束

| 规则 | 说明 |
|---|---|
| 不引依赖 | 除了已装的 `vue` / `element-plus` / `@element-plus/icons-vue`，什么都不许加 |
| 不写死颜色 | 一律 `var(--erp-*)`；间距用 `--erp-gap`、`--erp-pad-card` |
| 文案走 t() | 只写你自己的 i18n 文件，key 前缀用你的编号（如 `f2.plans.title`） |
| 状态推进只信 `allowed` | 后端每行都带 `allowed` 数组，别自己抄状态机 |
| 分页是游标 | 底栏放「加载更多」，**不要 `el-pagination`** |
| 错误展示 | `fieldErrors(err)` 或 `err.details?.reason`；列表失败要留 `el-alert`，不白屏 |
| 接口前缀 | 全部走 `/api/...`，租户前缀由 `api.js` 自动加 |

## 3. 五项交代（写进报告，各一句）

空态 / 加载 / 错误 / 超长文本（`erp-ellipsis` + `title`）/ 窄屏（`< 900px` 怎么退化）

## 4. 自测

```bash
cd web && npm i --include=dev --silent && npm run build    # 必须成功
```

你开不了浏览器，所以：构建通过 + 代码审查 + 严格按参考实现的结构。

## 5. 收尾

`git add -A && git commit` —— **最后一步必须是 commit**。

最后一次回复 ≤ 20 行：新建了哪些文件、每页的数据来源与行操作、五项交代各一句、build 结果、取舍与没做到的地方。

---

# 分工

## F1 · 审批与通知（i18n 前缀 `f1`）

| 文件 | 页面 |
|---|---|
| `views/ApprovalCenterView.vue` | 我的待办（`GET /api/approvals/my-tasks`）+ 我发起的（`GET /api/approvals?mine=1` 若无则用现有接口）；行操作「同意 / 驳回」（`POST /api/approvals/tasks/:id/decide`），驳回要填原因；抽屉显示事件流（`GET /api/approvals/:id/events`）和快照链路 |
| `views/ApprovalFlowView.vue` | 流程配置列表 + 新建/编辑抽屉（`/api/approval/flows`）；`steps` 是数组，编辑用可增删行的表单：级号、审批人类型（role/user/manager）、审批人、模式（any/all）、金额下限/上限 |
| `views/NotifySettingsView.vue` | 两个 Tab：渠道（`/api/notify/channels`，密钥只回 `configured:true`，编辑时留空表示不改）与模板（`/api/notify/templates`，含中英双语）；底部一个「发测试消息」按钮（`POST /api/notify/test`） |
| `views/InboxView.vue` | 站内信（`GET /api/notify/inbox`），未读优先、点开标记已读（`POST /api/notify/inbox/:id/read`）、全部已读 |

## F2 · 施工（i18n 前缀 `f2`）

| 文件 | 页面 |
|---|---|
| `views/WorkPlanView.vue` | 施工计划列表 + 新建；行内展开或抽屉显示任务（`/api/work-tasks?planId=`），任务可 `advance` 推进状态、填进度 |
| `views/MaterialIssueView.vue` | 领料单列表 + 新建（含明细行 item 下拉）、提交审批（`POST /api/material-issues/:id/submit`）；**被审批拒绝或缺库存时要显示 `errorMessage`** |
| `views/ChangeOrderView.vue` | 变更签证列表 + 新建 + 提交审批；显示审批状态与金额 |
| `views/AcceptanceView.vue` | 验收单列表 + 新建（含验收项）+ 推进（`/:id/advance`） |
| `views/LaborHourView.vue` | 工时登记（`/api/labor-hours`）按项目/日期过滤 |

## F3 · 采购与财务（i18n 前缀 `f3`）

| 文件 | 页面 |
|---|---|
| `views/PurchaseOrderView.vue` | 采购单列表 + 新建抽屉（明细行：物料下拉/数量/单价，前端实时算合计但**以后端 amount 为准**）+ 提交审批；行状态与 `allowed` |
| `views/GoodsReceiptView.vue` | 收货单列表 + 新建（选 PO、按行填收货数量，显示 PO 行剩余量） |
| `views/SubcontractView.vue` | 分包列表 + 进度款申请与提交审批 |
| `views/LedgerView.vue` | 两个 Tab：应收 / 应付（余额走 `/api/ar-ledger/balance`、`/api/ap-ledger/balance`）+ 收款/付款（`/api/payments`），超额核销后端会 409，把 `reason` 显示出来 |
| `views/ProfitView.vue` | 选项目 → `GET /api/projects/:id/profit` 显示营收/成本/毛利/毛利率；用 `el-descriptions` + 一个简单条形对比 |

## F4 · 售后 / 集成 / AI（i18n 前缀 `f4`）

| 文件 | 页面 |
|---|---|
| `views/TicketView.vue` | 工单列表 + 新建 + 推进（`/:id/advance`，允许挂起/恢复）+ 派工抽屉；显示 SLA 剩余时间（`/api/sla/overdue` 可做「超时」筛选） |
| `views/ServiceContractView.vue` | 服务合同列表 + 新建/编辑 |
| `views/IntegrationView.vue` | 集成配置（钉钉/企微）：`corpId/agentId/secrets`，密钥留空表示不改；手动同步按钮（`POST /api/integrations/:id/sync`）显示本次 counts；同步日志列表 |
| `views/AiChatView.vue` | 对话页：输入 → `POST /api/ai/chat` → 显示模型返回与生成的草稿；未配置时显示 503 的原因而不是白屏 |
| `views/AiDraftView.vue` | 草稿列表（`/api/ai/drafts`）+ 详情抽屉（payload 与 preview 对照）+ 通过/驳回/落库（`approve`/`reject`/`apply`）；`failed` 的草稿要显示 error 并允许重试 |
