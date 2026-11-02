# 信息化集成企业管理系统

面向系统集成公司的全流程管理系统：设计 → 施工 → 验收 → 质保 → 售后。

- **零 Web 框架、零 ORM**：HTTP 层、SQL 层、迁移器、校验、分页全部手写
- **运行时依赖只有两个**：`pg`、`mysql2`
- **双库等权**：PostgreSQL 16+ 或 MySQL 8.0+，CI 矩阵两项都跑
- **多租户**：共享库共享表 + `tenant_id`，跨租户引用物理上不可能
- **许可证**：AGPL-3.0

唯一权威文档：[`docs/DESIGN.md`](docs/DESIGN.md)（v0.4）· M0 细化：[`docs/M0-DESIGN.md`](docs/M0-DESIGN.md)

## 状态

M0 · S4 完成 —— 骨架 + 双库迁移（11 表）+ 认证/租户/权限 + 四模式注册

## 首次进入

```bash
node cmd/tenant.mjs create --slug demo --name "演示集成" --email boss@demo.cn --password demo12345
# 登录：POST /api/auth/login  {"email":"boss@demo.cn","password":"demo12345"}
# 带 cookie 访问 /t/demo/api/me
```

注册策略改配置不用重启（最长 30 秒生效）：

```bash
node cmd/settings.mjs list
node cmd/settings.mjs set registration.mode open      # closed | invite | email | open
node cmd/settings.mjs set registration.captcha math    # none | math
node cmd/user.mjs pending                             # require_admin_approval=true 时
node cmd/user.mjs approve someone@example.com

## 起本地环境

```bash
npm i
cp .env.example .env              # 端口被占用就改 PORT / DB_PORT
docker compose up -d              # Postgres 16 → 127.0.0.1:5433
node cmd/migrate.mjs up           # 空库建表
node cmd/migrate.mjs check        # 声明 vs 实际库结构，漂移即非零退出
node --test                       # 用例
node cmd/server.mjs               # GET /healthz
```

第二库（MySQL 8.0 → 127.0.0.1:3308）：

```bash
docker compose --profile mysql up -d
DB_DRIVER=mysql DB_PORT=3308 node cmd/migrate.mjs up
DB_DRIVER=mysql DB_PORT=3308 node cmd/migrate.mjs check
```

## 改表结构的唯一流程

1. 改 `schema/*.mjs`（表结构单真源）
2. `node cmd/migrate.mjs gen 0002_add_xxx` → 生成 `migrations/{pg,mysql}/0002_*.sql`，**两份都提交**
3. `node cmd/migrate.mjs up`，再 `check`
4. **不要手改已应用的迁移文件** —— checksum 会拦住；要改就新增 000N

## 分层铁律

`api/` 无 SQL · `store/` 无业务判断 · `svc/` 唯一开事务处 · 租户表 SQL 必带 `$t`
