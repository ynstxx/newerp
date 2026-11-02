# 信息化集成企业管理系统

面向系统集成公司的全流程管理系统：线索 → 设计 → 施工 → 验收 → 质保 → 售后。

- **零 Web 框架、零 ORM**：HTTP 层、SQL 层、迁移器、校验、分页全部手写
- **运行时依赖只有两个**：`pg`、`mysql2`
- **双库等权**：PostgreSQL 16+ 或 MySQL 8.0+，CI 矩阵两项都跑
- **多租户**：共享库共享表 + `tenant_id`，跨租户引用物理上不可能
- **许可证**：AGPL-3.0

唯一权威文档：[`docs/DESIGN.md`](docs/DESIGN.md)（v0.4）

**新会话从这里开始** → [`docs/HANDOVER.md`](docs/HANDOVER.md)：现状、代码地图、与设计文档的差异、踩过的坑、下一步
**已知问题** → [`docs/OPEN-ISSUES.md`](docs/OPEN-ISSUES.md)：29 条，每条都有「现状 + 何时做」

## 状态

DESIGN 的七个里程碑（M0–M7）全部落地。

```
75 表 · 16 支迁移 · 183 用例（PG / MySQL 双绿）
后端 30,577 行 · 前端 14,348 行 · 运行时依赖 2 个
```

## 跑起来

```bash
npm i
docker compose up -d              # Postgres 16 → 127.0.0.1:5433
cp .env.example .env              # 端口被占就改 PORT / DB_PORT
node cmd/migrate.mjs up           # 空库建表
npm run seed                      # 演示公司 + 一批业务数据（幂等）
node cmd/server.mjs
```

打开 `http://<本机地址>:8080/`（本机 8080 被别的服务占用时，`.env` 里改成 8099）。
演示账号：`boss@demo.cn` / `demo12345`。

第二库：

```bash
docker compose --profile mysql up -d   # MySQL 8.0 → 127.0.0.1:3308
DB_DRIVER=mysql DB_PORT=3308 node cmd/migrate.mjs up
DB_DRIVER=mysql DB_PORT=3308 npm test
```

前端开发模式（热更新，两个终端）：

```bash
node cmd/server.mjs
cd web && npm i && npm run dev         # 5173，/api 与 /t 代理到后端
```

## 改表结构的唯一流程

1. 改 `schema/*.mjs`（表结构单真源，`index.mjs` 自动发现）
2. `node cmd/migrate.mjs gen 0002_add_xxx` → 生成 `migrations/{pg,mysql}/0002_*.sql`，**两份都提交**
3. `node cmd/migrate.mjs up`，再 `check`
4. **不要手改已应用的迁移** —— checksum 会拦住；要改就新增 `000N`

## 分层铁律

`api/` 无 SQL · `store/` 无业务判断 · `svc/` 唯一开事务处 · 租户表 SQL 必带 `$t` · 跨租户一律 404

## 门禁（CI 五个作业）

| 作业 | 做什么 |
|---|---|
| `test-pg` | 空库建表 → `migrate check` → 再 `up` 验幂等 → 全量用例 → 健康检查 |
| `test-mysql` | 同上，换 MySQL 8.0（故意用 `TZ=Asia/Shanghai`：时间戳按本地墙钟落库才会红） |
| `dual` | 两库同场，`information_schema` 归一化后**逐字节比对** |
| `web` | 前端构建 + 静态托管门禁 |
| — | `npm run typecheck`（`tsc --noEmit`，只检查不产出） |

业务代码里跑不到的那道门：`test/tenant_guard.test.mjs` 扫 `store/**/*.mjs` 的 SQL 字面量 ——
碰租户表却漏 `$t`、INSERT 看不出 `tenant_id` 来源、全局表 `auth_user` 被裸写，都直接红。

## 健康与上线

```bash
curl -s localhost:8080/healthz
# {"ok":true,"db":"up","version":"0.0.1","env":"development","uptime":3,"requestId":"…"}
```

`NODE_ENV=production` 时必须给 `APP_SECRET`（`openssl rand -hex 32`），否则**拒绝启动**。
升级/回滚见 [`docs/UPGRADE.md`](docs/UPGRADE.md)，备份用 `node cmd/backup.mjs`。
