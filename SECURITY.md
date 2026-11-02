# 安全策略

NewERP 是面向系统集成公司的多租户 ERP，默认自托管、也可作为云平台运行。
这份文档说明**哪些版本会修**、**漏洞怎么私下报**、**当前代码里已经做了什么**，以及**哪些地方仍然不够**。

---

## 支持版本

| 版本 | 支持状态 | 说明 |
|---|---|---|
| v1（当前 `main`，包版本 `0.0.x`） | ✅ 维护 | 免费使用；安全修复只进 `main` |
| 更早的提交 / 分支 | ❌ 不维护 | 不提供 cherry-pick、不提供 LTS 补丁 |

- **单分支策略**：只维护 `main`。没有 `v1.0.x` 之类的长期支持分支。
- 预发布阶段（`0.0.x`）数据库结构仍可能变化，升级前请先备份，见 [`docs/UPGRADE.md`](docs/UPGRADE.md)。
- 发现安全问题后，修复会尽快进入 `main`；不会为旧提交单独发版。

---

## 私下报告漏洞

**请不要开公开 issue、公开 PR，也不要在社交平台贴 PoC。**

请发邮件到：

> **security@example.com**（占位地址，正式发布前会替换为真实安全邮箱）

邮件里尽量包含：

1. 受影响的版本 / commit、数据库类型（PostgreSQL / MySQL）；
2. 复现步骤或最小 PoC（**不要**附带真实客户数据、密钥、会话 Cookie）；
3. 影响判断：跨租户读写、权限提升、密钥泄漏、拒绝服务等；
4. 你希望如何署名（或不署名）。

处理方式（尽力而为，当前是单维护者项目）：

- **3 个工作日内**确认收到；
- 评估后在 **90 天内**给出修复或缓解方案，并与报告者协调公开时间；
- 修复发布后再公开细节；如果你希望提前公开，请先和我们确认。
- 目前没有 PGP 公钥，也没有漏洞赏金。需要加密通信时请在邮件里说明，我们再约定方式。

---

## 安全设计要点（逐条对应代码）

### 1. 租户三道防线

| 防线 | 实现 | 说明 |
|---|---|---|
| ① SQL 强制租户谓词 | `db/index.mjs` 的 `prepare()` | SQL 里写 `$t`，运行时替换为 `tenant_id = $N`；租户值只来自 `ctx.tenantId`，调用方不能传；缺租户直接抛错 |
| ② 静态守卫扫描 | `test/tenant_guard.test.mjs` | 扫 `store/**/*.mjs` 的 SQL 字面量；碰租户表却没有 `$t`、动态表名又没有 `$t` → CI 失败 |
| ③ 隔离回归测试 | `auth/tenant.mjs` + 各域 `*.test.mjs` | 每次请求都校验 `org_membership`；非成员、跨租户对象一律 **404**（不返回 403，避免泄漏“存在”） |

主键统一是 `(tenant_id, id)`，跨租户外键在物理上无法成立（例如 `(tenant_id, project_id)` 指向 `project(tenant_id, id)`）。
**注意**：防线②是正则扫描，不是 AST 证明；它抓“明显漏写”，不能替代人工评审，盲区见 [`docs/OPEN-ISSUES.md`](docs/OPEN-ISSUES.md) 第 23 条。

### 2. 密码

`auth/password.mjs`：

- `scrypt(N=16384, r=8, p=1)`，每个用户独立随机 salt；
- 比对用 `timingSafeEqual`，长度不等直接失败；
- 不存明文、不存可逆密文。

### 3. 服务端会话，可吊销

`auth/session.mjs`、`store/session.mjs`：

- 会话是数据库里的 `auth_session` 行，Cookie 里只放不可猜的随机 `sid`；
- Cookie 为 `HttpOnly; SameSite=Lax`，生产环境额外加 `Secure`；
- 每次请求都按 `expires_at` 校验；退出登录直接 `DELETE` 该行，**不用 JWT**（JWT 无法即时吊销）；
- 租户不是会话里的“授权事实”：每次 `/t/{slug}/…` 请求都重新查 `org_membership`，成员被踢后旧会话也进不去。

### 4. 密钥加密存储

`svc/ai_crypto.mjs`、`svc/notify_crypto.mjs`、`svc/integration_crypto.mjs`：

- 所有第三方密钥（AI `api_key`、邮件/短信/机器人密钥、钉钉/企微 secret）落库前用 **AES-256-GCM** 加密；
- 随机 12 字节 IV + 16 字节 auth tag，密文 base64 存储；
- 密钥由 `APP_SECRET` 派生，**永不回显**，前端只能看到“已配置”；
- `NODE_ENV=production` 且未设置 `APP_SECRET` 时拒绝启动（`config.mjs` 的 `assertProductionConfig`）；
- 换 `APP_SECRET` 后旧密文解不开，这是预期行为，不是 bug。

### 5. AI 没有直接写库的通道

`svc/ai_tools.mjs`、`svc/ai_draft.mjs`：

- 工具只有两种形状：`read` 带 `run()`，`write` 只带 `draft()`；
- `registerTool()` 对 `write` 工具**硬性禁止声明 `run`**，并 `Object.freeze`；`callRead()` 也会拒绝 `write` 工具；
- AI 只能生成 `ai_draft(status=pending)`，人工逐字段核对并审批通过后，才调用与人工完全相同的 `svc` 函数落库；
- 每次调用写 `ai_trace`，按租户隔离。

### 6. 审计表只插不改

`store/audit.mjs` 只导出 `insert`，没有 `UPDATE` / `DELETE` 语句；审计行包含 `before_json` / `after_json` / `trace_id` / `at`，并按 `tenant_id` 隔离。
**边界**：这是应用层约定，不是数据库触发器或只读账号强制；拥有数据库超级用户权限的人仍可改历史。

---

## 已知安全边界（没做完，不要当成已支持）

以下问题都真实存在，已在 [`docs/OPEN-ISSUES.md`](docs/OPEN-ISSUES.md) 里编号登记：

| # | 边界 | 影响 | 现状 |
|---|---|---|---|
| 7 | `scope='own'/'dept'` 数据范围未实现 | 列表目前只按 `$t` 过滤；`ctx.role.scope` 读了但没用。`member` 角色理论上可看到同租户内其他人负责的数据 | 等真实诉求（M3/M4）再补 |
| 28 | `POST /api/notify/test` 只要求登录 | 任何成员都能用本租户已配置的渠道（SMTP / 群机器人 webhook）发真实消息 | 应提到 `notify:config` |
| 18 | 台账核销缺行锁 / 幂等唯一键 | `ar_ledger` / `ap_ledger` 的“先 `SUM` 再插入”在并发下可能超额核销，余额变负；重复 POST 会重复登记 | 需要迁移 + 核销前加锁 |
| 27 | 跨租户外键返回 400 而非 404 | 响应与“陌生 uuid”字节级相同，不泄漏存在性，但与“一律 404”的约定不一致 | 待统一 |
| 23 | 租户守卫有静态盲区 | `tenant-free` 纯子串判断、INSERT 例外看不到值来源、全局表不在扫描范围 | 待收紧为带理由的标记 + 全局写白名单 |

如果你发现上表之外的问题，仍然请按上面的方式私下报告。
