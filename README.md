# 信息化集成企业管理系统

面向系统集成公司的全流程管理系统：设计 → 施工 → 验收 → 质保 → 售后。

- **零 Web 框架、零 ORM**：HTTP 层、SQL 层、迁移器、校验、分页全部手写
- **运行时依赖只有两个**：`pg`、`mysql2`
- **双库等权**：PostgreSQL 16+ 或 MySQL 8.0+，CI 矩阵两项都跑
- **多租户**：共享库共享表 + `tenant_id`，跨租户引用物理上不可能
- **许可证**：AGPL-3.0

唯一权威文档：[`docs/DESIGN.md`](docs/DESIGN.md)（v0.4）· M0 细化：[`docs/M0-DESIGN.md`](docs/M0-DESIGN.md)

## 状态

## 状态

**M0 完成** —— 骨架 + 双库迁移（11 表）+ 认证/租户/权限 + 四模式注册 + 客户主数据 CRUD + 双库等价门禁 + 前端外壳

## 两条跑法

**开发（两个终端）**

```bash
node cmd/server.mjs          # 后端 :8080（本机被占就让 .env 指到 8099）
cd web && npm run dev        # 前端 :5173，/api 与 /t 代理到后端
```

**构建后一体化**

```bash
cd web && npm run build      # 产物进 web/dist，由 http/static.mjs 托管
node cmd/server.mjs          # 直接开 localhost:8080 就能用
```

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

## 门禁（CI 四项）

| 作业 | 做什么 |
|---|---|
| `test-pg` | 空库建表 → `migrate check` → 再 `up` 验幂等 → 全量测试 → 健康检查 |
| `test-mysql` | 同上，换 MySQL 8.0 |
| `web` | 前端构建 → 静态托管门禁（index / 带 hash 产物 / SPA 回落 / ETag 304 / 不泄漏密钥） |
| `dual` | 两个库同时在场，`information_schema` 归一化后**逐字节比对** |
| `npm run typecheck` | `tsc --noEmit`（仅检查，不产出 JS） |

业务代码里跑不到的那道门是 `test/tenant_guard.test.mjs`：扫 `store/**/*.mjs` 的 SQL 字面量，碰租户表却漏 `$t` 直接红。

## 健康与上线

```bash
curl -s localhost:8080/healthz
# {"ok":true,"db":"up","version":"0.0.1","env":"development","uptime":3,"requestId":"…"}
```

`NODE_ENV=production` 时必须给 `APP_SECRET`（`openssl rand -hex 32`），否则**拒绝启动** —— 抱默认密钥跑等于会话和人机校验都白做。
