# 信息化集成企业管理系统 —— 设计方案 v0.4（定稿）

> 面向信息化系统集成公司（设计 → 施工 → 验收 → 质保 → 售后）的全流程管理系统。
> 后端**零 Web 框架、零 ORM**；**多租户 SaaS**；**PostgreSQL + MySQL 双支持**；
> 开源 **AGPL-3.0**；内置 AI 助手，起草单据后**必须人工审批才落库**。

**版本演进**

| 版本 | 变更 |
|---|---|
| v0.1 | 初版：单实例单公司、仅 Postgres、Apache-2.0 |
| v0.2 | 改为**多租户**、**PG+MySQL 双支持**、**AGPL-3.0** |
| v0.3 | 注册方式**可配置不写死**；补全**审批引擎**、**通知中心**（邮件/短信/站内信）、**钉钉/企业微信集成**；MySQL 进 CI 矩阵；工时 113 → 139 人日 |
| v0.4 | **定稿**：自托管**允许多租户**（管关联公司）；无待定项；总工时 145 人日；补 §18 开工交接 |

---

## 1. 定位：两种形态，一套代码

| 形态 | 使用者 | 说明 |
|---|---|---|
| **云平台** | 我们运营 | 一个部署多家公司，`/t/{slug}/` 隔离，免费注册 |
| **自托管** | 客户自己 | 默认建一个租户；**也可开多租户管多家关联公司**（已确认） |

**非目标**：微服务、消息队列、Redis、通用工作流引擎、插件系统、GraphQL、自己写存储引擎。

---

## 2. 技术选型

| 层 | 选型 | 依赖性质 |
|---|---|---|
| 运行时 | **Node.js ≥ 22 + TypeScript** | 本机已装 v22.23.3 |
| HTTP | `node:http` | 标准库（Express/Fastify 底层） |
| 路由/中间件/校验/分页/SSE/静态 | **全部自己写** | ≈1410 行 |
| 数据库 | **PostgreSQL 16+ 或 MySQL 8.0+** | 部署时二选一 |
| 驱动 | `pg` **和** `mysql2` | 唯一两个运行时依赖 |
| 密码哈希 | `node:crypto` scrypt | 标准库 |
| 加密（密钥/回调验签） | `node:crypto` aes-256-gcm / hmac | 标准库 |
| 邮件 SMTP | **手写 SMTP 客户端** | ≈250 行（内网自托管唯一可选） |
| 邮件 HTTP API | 内置 `fetch` | 零依赖（Resend/SendGrid/Mailgun） |
| 短信 | 内置 `fetch` 调云厂商 API | 零依赖，provider 可插拔 |
| 钉钉/企业微信 | 内置 `fetch` | 零依赖 |
| 测试 | `node:test` | 标准库 |
| AI | 内置 `fetch` 直连 OpenAI 兼容端点 | 零依赖 |
| 前端 | Vue 3 + Vite + Element Plus | 不受"手写"约束 |
| 许可证 | **AGPL-3.0** | |

**运行时依赖总数：2 个（`pg`、`mysql2`）。** 全部 MIT，与 AGPL-3.0 兼容。

---

## 3. 总体架构

```
                  ┌─ 租户解析中间件 /t/{slug}/… 或 子域 ─┐
┌─────────────────┴─────────────────────────────────────┐
│ cmd/server.mjs        （一个进程，一个端口）           │
├───────────────────────────────────────────────────────┤
│ web/       前端构建产物                                │
│ http/      路由·中间件·JSON·SSE·上传·静态   ← 手写     │
│ api/       handler（薄，无 SQL）                       │
│ svc/       业务规则·状态机·事务边界         ← 唯一写库 │
│ store/     原生 SQL，一域一文件，强制 $t     ← 手写    │
│ approval/  审批引擎（有序链 + 金额条件）     ← 手写    │
│ notify/    通知中心（outbox 表当队列）       ← 手写    │
│ integrate/ 钉钉·企业微信·SMTP·短信           ← 手写    │
│ ai/        LLM 客户端·工具注册·草稿          ← 手写    │
│ auth/      会话·成员·权限·数据范围·租户               │
│ db/        方言适配·连接池·迁移器            ← 手写    │
│ schema/    ★ 表结构唯一真源（TS 声明）                 │
│ migrations/{pg,mysql}/0001_init.sql  （生成后提交）    │
└───────────────────────────────────────────────────────┘
              ↓                        ↓
        PostgreSQL 16              MySQL 8.0
```

**铁律**：`api/` 无 SQL；`store/` 无业务判断；`svc/` 是唯一开事务的地方；任何租户表查询必带 `$t`。

---

## 4. 多租户设计

### 4.1 策略：共享库共享表 + `tenant_id`

| 排除方案 | 原因 |
|---|---|
| 每租户一库/一模式 | 迁移跑 N 次、连接池爆炸；MySQL 侧尤其糟 |
| PostgreSQL 行级安全 RLS | **MySQL 无对应能力**，双库支持破功 |
| 表名前缀 | SQL 全靠动态拼接，手写反而更危险 |

### 4.2 数据模型骨架

```sql
-- 全局表（无 tenant_id）
auth_user(id, email UNIQUE, pwd_hash, pwd_salt, display_name, status, created_at)
org_tenant(id, slug UNIQUE, name, status, plan, join_policy, created_at)
org_membership(tenant_id, user_id, role_id, status, joined_at, PRIMARY KEY (tenant_id, user_id))
auth_role(tenant_id, id, code, name, scope, PRIMARY KEY (tenant_id, id))
auth_session(id, user_id, tenant_id, expires_at, ip, ua)

-- 业务表（全部带 tenant_id，复合主键）
CREATE TABLE work_task (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL,
  project_id uuid NOT NULL,
  status     text NOT NULL,
  version    int  NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, project_id, id),
  CONSTRAINT fk_task_project FOREIGN KEY (tenant_id, project_id)
    REFERENCES project (tenant_id, id)          -- ★ 跨租户引用物理上不可能
);
```

主键一律 `(tenant_id, id)`，`id` 由应用侧 `crypto.randomUUID()` 生成。
业务编码一律 `UNIQUE (tenant_id, code)`。

### 4.3 三道防线

**防线一 · `q()` 强制租户谓词**
```ts
q<Item>(ctx, `SELECT id, code FROM item WHERE $t AND item_type = $1`, [type])
// '$t' 由 ctx.tenantId 替换，调用方无权传入；缺失直接抛错
```

**防线二 · SQL 审计测试（CI 门禁）**
`test/tenant_guard.test.mjs` 扫 `store/**/*.mjs` 的 SQL 字面量，涉及租户表却没 `$t`、且不在 `TENANT_FREE` 白名单 → 失败。
`// ponytail: 正则扫源码做守卫，够用；要 AST 精确分析时再换`

**防线三 · 隔离回归测试**
每个接口建 A、B 两租户，用 B 的凭证访问 A 的数据 → 断言 **404**（不是 403，403 泄漏"存在"）。
**纪律：新功能 PR 必须附一条跨租户越权用例。**

### 4.4 租户解析与切换

URL 前缀 `/t/{slug}/`（默认，无反代/DNS 依赖）或子域（配 `SAAS_DOMAIN` 后启用）→ 校验 `org_membership` 有效 → **每请求都校验**（成员可被踢）。切换租户轮换会话 ID（防会话固定）。

### 4.5 平台能力

| 能力 | v1 |
|---|---|
| 配额 | `tenant_quota(max_users, max_storage_mb, max_ai_tokens)`，超限拒绝不降级 |
| 数据导出/删除 | 租户管理员可导出 JSON/CSV；删租户软删 + 30 天冷静期 |
| 计费 | **v1 不做**，只留 `plan` 与配额 |

### 4.6 注册与开通（**模式可配置，绝不写死**）

`platform_settings` 存全局键值，环境变量给默认值，**管理员后台可改，30 秒缓存热生效**。

```ts
mode: 'closed'     // 不开放注册，仅平台管理员建租户/建号
    | 'invite'     // 邀请码 / 邀请链接（默认）
    | 'email'      // 邮箱验证后自助注册
    | 'open'       // 完全自由注册（需人机校验 + 严格限流）
```

```ts
// svc/registration.mjs —— 唯一入口，新增模式只加一个分支，handler 不动
canRegister(input): { ok, reason?, nextStep: 'create'|'verify_email'|'admin_approve' }
```

其它可配置项（同一张 `platform_settings`，后台可改）：

| 键 | 作用 |
|---|---|
| `registration.mode` | 上表四选一 |
| `registration.captcha` | `none` / `math` / `turnstile`（Turnstile 走 fetch 校验，零依赖） |
| `registration.email_domain_whitelist` | 限定企业域名（如 `*.gov.cn`） |
| `registration.require_admin_approval` | 注册后是否需平台管理员放行 |
| `registration.default_plan` | 新租户默认套餐名 |
| `registration.tenant_name_template` | 如 `{user}的公司` |
| `tenant.join_policy` | 单租户维度：`invite_only` / `domain_auto_join`（同邮箱域自动入组） |

**为什么放配置表而不是环境变量**：客户是自托管企业，装机后改注册策略不该要求改 `.env` 重启。env 只提供初始值。

---

## 5. 手写 HTTP 层

| 组件 | 职责 | 行数 |
|---|---|---|
| `router` | 方法 + 分段匹配 `/projects/:id/tasks`；404/405 区分 | 250 |
| `context` | requestId、用户、**租户**、事务、deadline | 100 |
| `middleware` | recover → requestId → log → CORS → 限流 → 租户 → 认证 → 权限 | 230 |
| `body` | JSON 严格解析（拒绝未知字段）、体积上限 | 120 |
| `validate` | 声明式校验，统一错误 | 180 |
| `errors` | 错误码 + 状态映射 + 中英双语 | 90 |
| `page` | 游标分页 + 排序/过滤白名单 | 130 |
| `static` | 产物托管、ETag、SPA fallback、预压缩 | 80 |
| `sse` | 站内信/AI 流式推送 + 心跳 | 60 |
| `upload` | 裸二进制 `PUT /api/files/:id` | 70 |
| **合计** | | **≈1410** |

上传不走 multipart：手写解析器 200+ 行高风险代码，改为 URL 带名 + body 裸字节流式写盘。
`// ponytail: 不解析 multipart，2GB 上限靠 Content-Length 前置校验`

认证：服务端会话 + `HttpOnly; SameSite=Lax; Secure` Cookie（不用 JWT，无法吊销）。
密码：`scrypt(N=16384,r=8,p=1)` + 独立 salt + `timingSafeEqual`。
限流：内存令牌桶，按 `租户+IP` 双维度。`// ponytail: 单进程内存桶，多实例再换共享存储`

---

## 6. 数据层：双库支持

### 6.1 表结构单真源

`schema/*.mjs` 用 TS 声明表（不是 ORM，只是 DDL 的类型化声明）：

```ts
export const tables = [{
  name: 'project', tenant: true,
  cols: [
    { n: 'code',         t: 'code',  notNull: true },  // → varchar(64)
    { n: 'contract_amt', t: 'money', notNull: true, default: 0 },
    { n: 'ext',          t: 'json' },
    { n: 'created_at',   t: 'time' },
  ],
  uniq: [['code']], index: [['party_id','status']],
}]
```

`node cmd/migrate.mjs gen 0007_add_ticket` → 生成 `migrations/pg/0007_*.sql` 与 `migrations/mysql/0007_*.sql`，**两条提交进 git**（评审读得到 SQL，部署不需要生成器）。`migrate check` 比对两条与实际库结构，漂移即 CI 失败。

不写两套手写迁移：46+ 表 × 每个变更写两遍，是长期漂移的必然来源。生成器约 400 行，第 5 个迁移回本。

### 6.2 方言差异收敛表（消除差异，而非适配差异）

| 事项 | 决策 |
|---|---|
| 主键 | 应用侧 `randomUUID()` → **不用** `RETURNING`/`LAST_INSERT_ID` |
| 时间戳 | 应用侧生成 UTC → **不用** `now()`/`CURRENT_TIMESTAMP` |
| 占位符 | `$1` vs `?` → `db/rebind(sql)` 一处转换 |
| JSON 列 | PG `jsonb` / MySQL `json`；**只整存整取，不做 JSON 路径查询** |
| 布尔 | `boolean` / `tinyint(1)`，封在类型映射 |
| 时间类型 | PG `timestamptz` / MySQL `datetime(3)`，全部 UTC |
| Upsert | 默认不用：事务内 `UPDATE`；影响 0 行再 `INSERT` |
| 部分索引 | **不用**（PG 独有），需要就建全量索引 |
| 生成列 | **不用**，应用侧算 |
| 隔离级别 | 统一 `READ COMMITTED` |
| 行锁 | `SELECT … FOR UPDATE SKIP LOCKED`（**MySQL 8.0+ 同样支持**，通知队列靠它） |
| 迁移互斥 | PG `pg_advisory_lock` / MySQL `GET_LOCK` |
| 排序规则 | PG `COLLATE "C"` / MySQL `utf8mb4_0900_ai_ci`，显式声明 |

### 6.3 唯一数据库出口

```ts
query<T>(ctx, sql, args): Promise<T[]>
one<T>(ctx, sql, args): Promise<T|null>
exec(ctx, sql, args): Promise<number>
withTx(ctx, fn): Promise<T>        // 嵌套复用外层事务
```

动态 SQL 只允许来自白名单常量，**永不拼接用户输入**。

---

## 7. 领域模型

### 7.1 主链

```
线索 → 商机 → 立项 → 需求调研 → 方案设计(BOM) → 报价 → 合同
   → 采购/分包 → 进场施工(进度·领料·变更签证·隐蔽验收)
   → 整体验收 → 收款/开票 → 质保期 → 售后工单/SLA
```

### 7.2 表清单（约 64 张）

**平台**：`auth_user` · `org_tenant` · `org_membership` · `auth_role` · `auth_perm` · `auth_session` · `tenant_quota` · `tenant_invite` · `platform_settings` · `sys_config` · `sys_file` · `audit_log` · `login_attempt`

**审批**：`approval_flow` · `approval_instance` · `approval_task` · `approval_event`

**通知**：`notify_channel` · `notify_template` · `notify_outbox` · `notify_inbox`

**集成**：`integration_conn` · `integration_map` · `integration_sync_log`

**主数据**：`party` · `party_contact` · `item` · `item_uom` · `warehouse` · `stock_bin` · `stock_move` · `item_sn` · `price_book`

**售前/项目**：`lead` · `opportunity` · `project` · `project_stage_log` · `requirement` · `design_doc` · `bom_line` · `quotation` · `quotation_line`

**商务财务**：`contract` · `contract_line` · `contract_term` · `invoice` · `ar_ledger` · `ap_ledger` · `payment` · `cost_line`

**采购分包**：`purchase_order` · `po_line` · `goods_receipt` · `grn_line` · `subcontract` · `subcontract_progress`

**施工**：`work_plan` · `work_task` · `progress_log` · `material_issue` · `material_issue_line` · `change_order` · `acceptance` · `labor_hour` · `site_record`

**售后**：`service_contract` · `ticket` · `ticket_event` · `dispatch` · `maintenance_plan` · `maintenance_task` · `spare_part_move` · `satisfaction`

**AI**：`ai_settings` · `ai_draft` · `ai_trace`

### 7.3 状态机（集中在 `svc/*.mjs` 的 `TRANSITIONS` 表）

```
project: 草稿 → 立项 → 设计中 → 报价中 → 已签约 → 施工中 → 待验收 → 质保中 → 已关闭
                                                              ↘ 已终止
ticket:  待受理 → 已派工 → 处理中 → 待验证 → 已关闭
                       ↘ 挂起（SLA 暂停计时）
draft:   draft → pending → approved → applied  ↘ rejected  ↘ failed（可重试）
approval: pending → approved  ↘ rejected  ↘ withdrawn（提交人撤回）
```

**handler 里禁止直接 `UPDATE status`。**

---

## 8. 权限与数据范围

**权限串** `模块:动作`：`project:view`、`quotation:approve`、`ticket:dispatch`、`approval:delegate`、`notify:config`、`integration:config`。

**角色挂在 `org_membership` 上**（不是用户上）——同一个人在不同公司可不同角色。

**数据范围** `scope`：`all` / `dept`（本部门及下级）/ `own`（本人负责或参与）。由 `auth/scope.mjs` 生成固定列名的 `WHERE` 片段。

**权限矩阵（节选）**

| 对象 | 查看 | 新建 | 审批 | 配置 |
|---|---|---|---|---|
| 项目 | `project:view` | `project:create` | — | — |
| 报价 | `quotation:view` | `quotation:create` | `quotation:approve` | — |
| 采购单 | `purchase:view` | `purchase:create` | `purchase:approve` | — |
| 售后工单 | `ticket:view` | `ticket:create` | — | `ticket:dispatch` |
| 审批流程定义 | `approval:view` | — | — | `approval:config` |
| 通知渠道 | `notify:view` | — | — | `notify:config` |
| 外部集成 | `integration:view` | — | — | `integration:config` |
| AI 草稿 | 本人 `ai_draft:view` | — | `ai_draft:approve` | `ai:config` |

**审计**：所有 `svc` 写操作 → `audit_log(who, tenant, module, action, ref_id, before, after, trace_id)`。审计表只插不改不删，用 `REVOKE UPDATE, DELETE` 兜住。

**登录防护**：`login_attempt` 记失败，同账号 5 次/15 分钟锁，同 IP 20 次/小时锁。

---

## 9. 审批引擎（有序链 + 金额条件，**不做通用工作流**）

### 9.1 边界

| 支持 | 不支持（明确砍掉） |
|---|---|
| 有序多级审批（1→2→3） | 并行分支 / 会签网关 |
| 每级：任一通过 / 全部通过 | 条件分支表达式语言 |
| 金额阈值触发不同链路 | 图形化流程设计器 |
| 转办、代理、撤回 | 子流程嵌套 |
| 超时催办 | 定时器事件 |

**理由**：集成公司真实的审批是"按金额分级批"，不是 BPMN。做通用引擎会吃掉三个月且没人用。
`// ponytail: 只做有序链+金额档，真需要 DAG 时再引入（那时已有真实需求）`

### 9.2 表结构

```sql
approval_flow(tenant_id, id, code, name, doc_type, enabled,
              steps json,          -- [{no, approver_type, approver_ref, mode, min_amount, max_amount}]
              PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code))

approval_instance(tenant_id, id, flow_id, doc_type, doc_id,
                  status, current_step, amount,
                  flow_snapshot json,   -- ★ 提交时快照审批链，流程后改不影响历史
                  submitter_id, submitted_at, finished_at)

approval_task(tenant_id, id, instance_id, step_no, approver_user_id,
              status,  -- pending | approved | rejected | delegated | skipped
              acted_at, comment, remind_count, PRIMARY KEY (tenant_id, id))

approval_event(tenant_id, id, instance_id, actor_id, action, comment, at)
```

### 9.3 流程

```
提交(svc 里显式调用) → 按 doc_type + amount 选 flow → 快照 steps
  → 生成第 1 级 approval_task → 发通知给审批人
审批人处理 → 该级满足 mode(any/all) → 下一级 / 结束
  → 结束时回调 onApproved(ctx, docType, docId) 或 onRejected(...)
```

**审批与业务解耦**：`svc/approval_hooks.mjs` 注册 `doc_type → {onApproved, onRejected}`。业务单据只关心"我提交了审批 / 我被批了"，不关心链路。

### 9.4 审批人解析

```ts
approver_type: 'role'      // 角色（如 purchase_manager），该角色任一人可批
             | 'user'      // 指定人
             | 'manager'   // 提交人的上级（沿 org_dept 向上找）
             | 'field'     // 单据字段，如 project.pm_user_id
```

### 9.5 AI 草稿审批复用同一引擎

`ai_draft` 提交后 `doc_type='ai_draft'`，走同一套 `approval_*` 表、同一套 UI、同一套审计。**不另造一套审批**。

---

## 10. 通知中心（邮件 / 短信 / 站内信 / 钉钉 / 企微）

### 10.1 架构：DB 表当队列，不引 MQ/Redis

```
svc 里 emit(ctx, 'approval.pending', {docType, docId, recipients})
        ↓
notify_outbox  (pending → sending → sent / failed)
        ↓  单进程 worker poll（每 2s），SELECT … FOR UPDATE SKIP LOCKED
    ┌────┬─────┬───────┬─────────┬────────┐
  email  sms  inapp  dingtalk  wecom
```

`// ponytail: DB 当队列，单实例每分钟几千条足够；上量后换外部队列，接口不变`

### 10.2 表

```sql
notify_channel(tenant_id, id, type,     -- email|sms|inapp|dingtalk|wecom
               enabled, config json,     -- SMTP 主机/API key/webhook 等（密钥加密存）
               PRIMARY KEY (tenant_id, id))

notify_template(tenant_id, id, code, channel, lang,   -- lang: zh|en
                subject, body,        -- 占位符 {{doc_no}} {{amount}} {{approver}}
                PRIMARY KEY (tenant_id, id))

notify_outbox(tenant_id, id, channel, to_addr, template_code, vars json,
              status, attempts, next_retry_at, error, dedupe_key, created_at,
              PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, dedupe_key))

notify_inbox(tenant_id, id, user_id, title, body, link, read_at, created_at,
             PRIMARY KEY (tenant_id, id))
```

### 10.3 渠道实现

| 渠道 | 实现 | 成本 |
|---|---|---|
| **站内信** | 直接写 `notify_inbox` + SSE 实时推送 + 未读轮询兜底 | 60 行 |
| **邮件（HTTP API）** | `fetch` 调 Resend / SendGrid / Mailgun | 30 行/家 |
| **邮件（SMTP）** | **手写** SMTP 客户端：EHLO / STARTTLS / AUTH LOGIN / MIME 编码 / 附件 | ≈250 行，MIME 头与中文编码是坑 |
| **短信** | `fetch` 调阿里云 / 腾讯云，provider 接口可插拔（签名计算在 `integrate/sms_*.mjs`） | 80 行/家 |
| **钉钉群机器人** | `fetch` webhook + HMAC-SHA256 签名 | 40 行 |
| **企微群机器人** | `fetch` webhook | 30 行 |

**SMTP 为什么要自己写**：内网自托管客户往往只有内部邮件服务器，没有外网 API。这是"可部署在内网"承诺的一部分，250 行是必要成本。

### 10.4 可靠性与去重

- 重试：指数退避（1m/5m/15m/1h/6h），最多 5 次 → `failed` + 站内信通知管理员
- **幂等**：`dedupe_key = hash(tenant|channel|template|docId|step)`，重复 emit 只发一次
- 免打扰：`notify_pref(user, channel, event)` 用户可关某类通知；**审批待办不可关**（业务必需）
- 模板缺失 → 不发送，落 `failed` 并记 error（不静默吞掉）

### 10.5 事件源

`svc` 里显式 emit，收件人支持动态解析：

```ts
emit(ctx, 'approval.pending', {
  docType: 'purchase_order', docId: id,
  recipients: [{ role: 'purchase_manager' }, { field: 'project.pm_user_id' }],
})
```

v1 事件集：`approval.pending` · `approval.approved` · `approval.rejected` · `ticket.assigned` · `ticket.sla_warning` · `ar.overdue` · `stock.low` · `ai_draft.pending` · `tenant.quota_warning`

---

## 11. 外部集成：钉钉 / 企业微信

### 11.1 三条链路（按优先级）

| 链路 | 方向 | 用途 | v1 |
|---|---|---|---|
| **组织架构与人员同步** | 钉钉/企微 → 本系统 | 部门、成员、手机号自动落到 `org_dept` / `org_membership` | ✅ |
| **扫码登录（单点）** | 钉钉/企微 → 本系统 | 员工扫码直接进系统，免密 | ✅ |
| **消息推送** | 本系统 → 钉钉/企微 | 审批待办、告警推到群/个人 | ✅（走群机器人） |
| 待办双向同步 | 双向 | 钉钉待办里直接审批 | v2 |

**优先用群机器人 webhook，不用企业应用消息**：企业应用消息要审核、上线、IP 白名单，自托管客户做不到。群机器人一条 webhook 即可，5 分钟配完。

### 11.2 表

```sql
integration_conn(tenant_id, id, provider,   -- 'dingtalk' | 'wecom'
                 corp_id, agent_id,
                 secrets json,              -- appkey/appsecret/token/aes_key（加密存）
                 enabled, last_sync_at,
                 PRIMARY KEY (tenant_id, id))

integration_map(tenant_id, id, provider, external_type,  -- 'dept'|'user'
                external_id, local_id, synced_at,
                PRIMARY KEY (tenant_id, id),
                UNIQUE (tenant_id, provider, external_type, external_id))

integration_sync_log(tenant_id, id, provider, action, counts json, error, at)
```

`integration_map` 是同步的核心：**外部 ID ↔ 本地 ID 的映射表**。没有它，第二次同步就会重复建人。

### 11.3 同步策略

- **手动触发 + 每日定时**（默认 03:00），不做实时回调（内网部署收不到外网回调）
- 增量：按 `department/list` → 递归 `department/listsub` → 每部门 `user/list`
- 冲突：以外部为准更新姓名/手机/部门；**本系统内手工改过的角色不覆盖**（`integration_map` 有 `locally_modified` 标记）
- 离职：外部删除/停用的成员 → 本地 `org_membership.status='disabled'` 而非物理删除（历史单据要留人）
- 同步全过程写 `integration_sync_log`，后台可看"上次同步 37 部门 / 412 人 / 3 失败"

### 11.4 扫码登录

`/api/auth/oauth/{provider}/callback`：拿到 `code` → 换 `userid` → 查 `integration_map` → 找到 `auth_user` → 建会话。未映射则提示"请联系管理员同步通讯录"（**不自动建号**，避免越权）。

### 11.5 密钥与安全

- 所有 `secrets` 用 `aes-256-gcm` 加密存（密钥来自 `APP_SECRET` 环境变量），**永不回显**，前端只见"已配置"
- 回调验签：钉钉 `timestamp + sign` HMAC-SHA256；企微 `msg_signature` AES-256-CBC 解密，均用 `node:crypto` 手写
- 出站请求全部 15s 超时 + 最多 2 次重试，失败落 `integration_sync_log`

---

## 12. AI 层：起草 → 人工审批 → 落库

### 12.1 工具契约（结构性禁止直接写库）

```ts
type Tool = {
  name: string                  // 'create_purchase_order'
  level: 'read' | 'write'
  perm: string
  schema: JSONSchema
  run?(ctx, args): Promise<any>                     // 仅 read
  draft?(ctx, args): Promise<{payload, preview}>    // 仅 write，永不写库
}
```

**write 工具在类型上没有 `run`**，执行通道不存在。

### 12.2 落库路径（唯一入口）

```
AI: model → tool(draft) → 校验 schema → ai_draft(status=pending) → 给人看字段级 diff
人: 逐字段核对 → 通过 / 驳回(必填原因)
通过: ai_apply(ctx, draftId) →
  1. 开事务
  2. 重新校验 payload（草稿可能躺了几天：供应商已停用、物料已涨价）
  3. 调 svc.createPurchaseOrder(ctx, payload)   ← 与人工下单**完全同一个函数**
  4. 回写 applied_ref、status=applied、写 audit_log
  5. 提交
失败: status=failed + 错误详情，修 payload 可重试（幂等键防重复落单）
```

`ai_draft` 的审批**复用 §9 审批引擎**（`doc_type='ai_draft'`），不另造。

### 12.3 租户级配置与离线降级

`ai_settings`（`tenant_id` 维度）：`base_url` / `api_key`（加密）/ `model` / `enabled` / `max_tokens` / `timeout` / `monthly_token_limit`。

- 兼容任何 OpenAI 协议端点：云 API、Ollama、vLLM、本地模型
- 未启用或无 key → **AI 入口整体隐藏，其余功能完全可用**（内网离线部署必须）
- 超配额 → 明确提示并禁用，不静默失败
- 每次调用写 `ai_trace`（prompt / completion / tool_calls / 耗时 / token / 成本），按租户隔离

---

## 13. 部署

| 形态 | 方式 |
|---|---|
| 本地试用 | `docker compose up`（应用 + Postgres），`localhost:8080` |
| 云平台 | 应用 + Postgres + Nginx TLS；`SAAS_MODE=1` |
| 自托管内网 | 同上，`SAAS_MODE=0` 自动建默认租户；`AI_ENABLED=0`；通知走内网 SMTP |

配置全环境变量（12-factor）+ `platform_settings` 表覆盖。`DB_DRIVER=pg|mysql` 切换。
迁移启动时自动跑（advisory lock 互斥，多实例安全）。
`GET /healthz` → `{ok, db, version, ai, notify_worker, last_sync}`。
SIGTERM 优雅退出：停接新连接 → 等在途请求 ≤30s → 停 outbox worker → 关连接池。
备份：`cmd/backup.mjs` 封装 `pg_dump` / `mysqldump`。

---

## 14. 开源工程化

- **AGPL-3.0**：任何人可免费用、改、自托管；但把修改版**作为网络服务提供**时必须公开源码。对防"竞争对手拿去开闭源 SaaS"有效，对自托管客户零影响。依赖全部 MIT，兼容。
- **双语第一天**：`web/i18n/{zh,en}.json` + 服务端错误消息同字典。事后补 i18n 要改几千处。
- **CI 矩阵**：`{pg, mysql} × node 22`（**矩阵两项都必跑**）。迁移在两个空库各跑一遍，再比对 `information_schema`，不一致失败。
- 贡献门槛：`npm i` 两个依赖，`node --watch cmd/server.mjs` 起，无编译无 SDK。
- 必带文件：`SECURITY.md`、`CONTRIBUTING.md`（含"新功能必须附跨租户越权用例"）、`docs/UPGRADE.md`。

---

## 15. 里程碑

| 阶段 | 内容 | 验收标准 | 人日 |
|---|---|---|---|
| **M0** 骨架 | HTTP 层 + 双库适配 + 迁移生成器 + 租户/登录/成员 + **可配置注册** + `party` CRUD + 前端外壳 | 两库各起一套；四种注册模式切换生效无需重启；跨租户越权测试通过 | **22** |
| **M1** 项目主链 | 商机 → 立项 → 需求 → BOM → 报价 → 合同 | 一条项目走到签约，状态机不可跳级 | 20 |
| **M2** 审批 + 通知 | 审批引擎 + 站内信 + 邮件(HTTP/SMTP) + 短信 + outbox worker + 模板管理 | 报价超 10 万自动走 2 级审批，每级到人有站内信+邮件+短信，超时催办一次 | 16 |
| **M3** 施工 | 计划/进度/领料/变更签证/验收/工时 | 领料扣库存、变更单走审批并影响合同额、验收后转待收款 | 22 |
| **M4** 采购财务 | PO/收货/分包/应收应付/成本归集 | 项目毛利报表与手工核算一致 | 20 |
| **M5** 售后 | 服务合同 SLA/工单/派工/巡检/备件 | 超时按 SLA 标红并推通知；设备 SN 反查全部历史 | 18 |
| **M6** AI | 工具层 + 草稿审批（复用审批引擎）+ 流式对话 | 说"给 A 客户开 5 万采购单买 10 台交换机" → 草稿 → 人审 → 落库 → 单号可查 | 15 |
| **M7** 外部集成 | 钉钉/企微通讯录同步 + 扫码登录 + 群机器人推送 | 同步 400 人 2 分钟内完成，重跑不重复建人；钉钉扫码 3 秒进系统；审批待办推到群 | 12 |

**合计 ≈145 人日。**

**风险集中在 M0**（手写 HTTP + 双库 + 租户三重守卫）。M0 过，后面是业务填充。
**M2 必须在 M3 之前**：采购、变更、付款全依赖审批，顺序颠倒会返工。

---

## 16. 明确不做

- ❌ 微服务、消息队列、Redis（通知队列用 DB 表）
- ❌ **通用工作流引擎**（并行分支 / 条件网关 / 图形设计器）—— 只做有序审批链 + 金额档
- ❌ 每租户独立库/模式、PG RLS（MySQL 无对应能力）
- ❌ JSON 路径查询（只整存整取，保双库一致）
- ❌ 部分索引、生成列、`RETURNING`、`now()`（双库不一致的源头）
- ❌ 计费与支付（v1 只留 `plan` 与配额）
- ❌ 全文检索（先 `LIKE`/前缀索引，到瓶颈再说）
- ❌ 钉钉/企微待办双向同步（v2）
- ❌ 实时回调式组织同步（内网收不到外网回调）

---

## 17. 已确认事项

| 事项 | 结论 |
|---|---|
| 租户模型 | 多租户，共享表 + `tenant_id` |
| 数据库 | PostgreSQL + MySQL 双支持，**两者都进 CI 矩阵** |
| 前端 | Vue 3 + Element Plus（不受"手写"约束） |
| 许可证 | AGPL-3.0 |
| 收费 | v1 免费，不收订阅费，只留 `plan`/配额字段 |
| 注册 | **由后台设置决定**，四模式可切换，不写死 |
| 通知 | 邮件 + 短信 + 站内信（+ 钉钉/企微推送） |
| 外部集成 | 钉钉 / 企业微信：通讯录同步 + 扫码登录 + 群机器人 |
| 自托管多租户 | **允许**：一个部署可开多个租户，管多家关联公司 |

**无待定项。**

**术语约定**：界面与文档里一律叫「公司 / 组织」，代码、表、接口里一律用 `tenant` / `tenant_id`。
用户永远看到"公司"，代码里永远是 `tenant_id`。这样自托管单公司客户不会被"租户"这个词劝退，而多租户能力一行代码都不用改。

---

## 18. 开工交接（给新窗口/新角色）

**当前仓库状态**：`/home/stxx/NewERP` 只有 `docs/DESIGN.md` 一个文件，**没有任何代码**。

**开工只读这一份文档**，第 1–17 节即全部约束。不需要参考 `/home/stxx/erp-system`（那是另一套旧系统，与本项目无任何依赖关系，禁止 import、禁止抄代码）。

**M0 范围（唯一要做的）**

1. `http/` 全套：router · context · middleware · body · validate · errors · page · static · sse · upload
2. `db/`：双库连接池 · `rebind()` 方言 · `q/one/exec/withTx` · 迁移器（advisory lock + checksum）
3. `schema/` + `cmd/migrate.mjs gen`：生成 `migrations/{pg,mysql}/0001_init.sql`
4. `auth/`：scrypt 密码 · 会话表 + Cookie · 成员关系 · 权限串 · 数据范围
5. **可配置注册**（四模式）+ 租户创建
6. 一个业务闭环：`party`（客户/供应商）增删改查
7. 前端外壳：登录页 + 布局 + 客户列表（Vue 3 + Element Plus）
8. 测试：`tenant_guard` 源码扫描 + 跨租户越权用例 + 双库各跑一遍

**M0 验收（必须逐条能跑）**

```bash
docker compose up -d                      # 起 app + pg
node cmd/migrate.mjs up                   # 空库建表
node --test test/                         # 全绿
DB_DRIVER=mysql docker compose --profile mysql up -d && node cmd/migrate.mjs up  # 第二库同样建表
curl -s localhost:8080/healthz            # {"ok":true,...}
```

1. 四种注册模式在后台切换后 30 秒内生效，无需重启
2. 建租户 A、B，各建客户；用 B 的凭证读 A 的客户 → **404**（不是 403）
3. `platform_settings` 改 `registration.mode` 后行为立即变化
4. `node --test` 全绿，且 `information_schema` 双库比对一致

**M0 阶段禁止做的事**（容易提前跑偏）

- 不要引入第 3 个运行时依赖（现有只有 `pg`、`mysql2`）
- 不要写审批/通知/AI，那是 M2/M6
- 不要建 M1 之后的表
- 不要在 `api/` 里写 SQL，不要在 `store/` 里写业务判断
- 不要用 `RETURNING` / `now()` / 部分索引 / JSON 路径查询（双库会裂）
- 不要碰 `/home/stxx/erp-system`
