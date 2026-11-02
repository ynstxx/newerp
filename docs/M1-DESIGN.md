# M1 项目主链 · 架构定案

> 执行 `docs/DESIGN.md` §15 的 M1（商机 → 立项 → 需求 → BOM → 报价 → 合同，20 人日）。
> 冲突时以 DESIGN.md 为准。

---

## 1. 决策表

| # | 决策 | 选择 | 为什么 | 代价 |
|---|---|---|---|---|
| 1 | 表范围 | 11 表；**不含 `lead`**、**不含 `item` 主数据** | §15 的 M1 链从商机起；`item` 属采购/库存域 | M4 要销售漏斗时补 `lead` |
| 2 | BOM 物料 | 行内自由文本（`item_name/spec/uom`），不引 `item` | 不建主数据表就先把方案能做出来 | M3 加可空 `item_id` 并回填 |
| 3 | 报价行来源 | **BOM 快照**（拷名称/规格/数量），不引用 `bom_line` | 源单改版不能动已发出的单据 | 数据冗余，改价要重生成 |
| 4 | 合同行来源 | **报价行快照** | 同上 | 同上 |
| 5 | 状态机 | 每实体一张 `TRANSITIONS` + 共用 `svc/transition.mjs` 的 `assertTransition` | 非法跳转集中在一处拒绝 | 跨实体联动（合同签→项目签约）仍要显式调用 |
| 6 | 立项是否走审批 | **M1 不走**，`draft→approved` 直接推进 | 审批引擎是 M2；先统一走 `advance()` 入口，M2 在里面挂钩子 | M1 的立项是"有权限就能点" |
| 7 | 并发 | 全部沿用 `version` 乐观锁 | 与 party 一致 | — |
| 8 | 报价版本 | `quotation.version` = 该项目的第几版，**项目内不唯一** | 改版常见，旧版要留 | 查"当前有效版"要按 version 排序 |

---

## 2. 状态机

```
opportunity: new ─→ following ─→ won
                    └─────────→ lost        （won 时同事务建 project(status=draft)）

project:     draft ─→ approved ─→ designing ─→ quoting ─→ signed
                              ←──────────────┘   （报价阶段可退回改方案）
             除 signed 外任意状态 ─→ terminated

quotation:   draft ─→ sent ─→ accepted
                        └──→ rejected

design_doc:  draft ─→ confirmed
requirement: draft ─→ confirmed
contract:    draft ─→ signed            （signed 时同事务把 project 推到 signed）
```

**非法跳转一律 409**，错误体带 `allowed` 数组，前端只渲染合法按钮。

---

## 3. 数据流

```
POST   /t/{slug}/api/opportunities                    建商机（stage=new）
POST   /t/{slug}/api/opportunities/:id/advance        {to:'won'} → 同事务建 project(draft) + stage_log
POST   /t/{slug}/api/projects/:id/advance             draft→approved（立项）→designing→quoting
POST   /t/{slug}/api/requirements                     挂项目
POST   /t/{slug}/api/design-docs                      含 bomLines[]（自由文本）
POST   /t/{slug}/api/quotations                       {designDocId} → 快照生成 quotation + lines
POST   /t/{slug}/api/quotations/:id/advance           draft→sent→accepted|rejected
POST   /t/{slug}/api/contracts                        {quotationId} → 快照生成 contract + lines + terms
POST   /t/{slug}/api/contracts/:id/advance            draft→signed（同事务推 project→signed）
```

写操作统一：`need(ctx, PERM.x)` → `validate` → `svc`（`withTx` + `audit_log` + 乐观锁）。

---

## 4. 表（`0002_m1_project_chain`，11 张）

`opportunity` · `project` · `project_stage_log` · `requirement` · `design_doc` · `bom_line`
`quotation` · `quotation_line` · `contract` · `contract_line` · `contract_term`

所有租户表：复合主键 `(tenant_id, id)`，外键复合指向 `(tenant_id, id)`，`qty/price/amount` 用 `money`（numeric 18,2）。

---

## 5. 并行开发契约（多 Agent）

| 切片 | 表 | 文件（只允许新建/修改这些） |
|---|---|---|
| A 商机+立项 | opportunity, project, project_stage_log | `store/opportunity.mjs` `store/project.mjs` `svc/opportunity.mjs` `svc/project.mjs` `api/opportunity.mjs` `api/project.mjs` `api/routes-a.mjs` `test/m1_a.test.mjs` |
| B 需求+BOM | requirement, design_doc, bom_line | `store/requirement.mjs` `store/design.mjs` `svc/requirement.mjs` `svc/design.mjs` `api/requirement.mjs` `api/design.mjs` `api/routes-b.mjs` `test/m1_b.test.mjs` |
| C 报价 | quotation, quotation_line | `store/quotation.mjs` `svc/quotation.mjs` `api/quotation.mjs` `api/routes-c.mjs` `test/m1_c.test.mjs` |
| D 合同 | contract, contract_line, contract_term | `store/contract.mjs` `svc/contract.mjs` `api/contract.mjs` `api/routes-d.mjs` `test/m1_d.test.mjs` |

**硬约束**

- 路由用 `export function register(router)` 挂在 `api/routes-<切片>.mjs`，**不许改 `cmd/server.mjs`**。
- 不许改 `schema/`、`migrations/`、`docs/`、`package.json`、`http/`、`db/`、`auth/`、任何其他切片的文件。
- 跨切片读数据（报价读 BOM、合同读报价）**写自己的只读 SQL**，不 import 别人的 store —— 并行期避免编译耦合，合并后可选收敛。
- 各自的数据库：`DB_NAME=newerp_m1_<切片>`（PG），PG 16 @ 127.0.0.1:5433，账号 newerp/newerp。
- 测试必须包含跨租户 404 用例（DESIGN §4.3 纪律）。

---

## 6. 这次不做什么

| 不做 | 什么时候做 |
|---|---|
| `lead` 线索表、销售漏斗统计 | M4 |
| `item` / `item_uom` / 库存 | M3 |
| 报价审批、立项审批、合同审批 | M2（审批引擎）|
| 合同附件、电子签、补充协议 | M3 及以后 |
| `project_member` 成员表 | 用 `pm_user_id` 够用，需要多人时再建 |
| 部门树、`scope=dept` | `org_dept` 落地时 |
| 6 套独立前端 CRUD | M1 只做一个「项目工作台」单页 |
| 项目成本归集、毛利 | M4 |
