# M0 骨架 · 架构定案

> 本文是 `docs/DESIGN.md`（v0.4）第 18 节的执行细化，**不覆盖**其任何约束。
> 冲突时以 DESIGN.md 为准。总工时 24 人日（设计稿 22，+2 为双库比对器与 DDL 校验）。

---

## 1. 决策表

| # | 决策点 | 选择 | 为什么 | 代价 |
|---|---|---|---|---|
| 1 | 语言产物 | `*.mjs` 纯 JS + JSDoc，`tsc --noEmit --checkJs` 仅做检查 | DESIGN §14「无编译无 SDK」；全文文件名均为 `.mjs` | 无真编译期检查；JSDoc 啰嗦 |
| 2 | 目录 | 扁平顶层（无 `src/`） | 少一层路径，与 §3 架构图一致 | 根目录条目多 |
| 3 | 依赖边界 | 根 `package.json`：`pg`+`mysql2`（dev: `typescript`、`@types/node`）<br>`web/package.json`：Vue 全家桶 | 前端依赖不污染「运行时只有两个」 | 两次 `npm i` |
| 4 | DB 出口 | `q/one/exec/withTx`，连接挂在 `ctx.conn` | `svc` 是唯一开事务处；`withTx` 嵌套复用外层 | `ctx` 必须一路透传，漏传即报错 |
| 5 | 迁移 | `schema/*.mjs` + `schema/snapshot.json` → diff → 双份 SQL，提交 git | 手写两份必然漂移；解析已有 SQL 太重 | 快照需提交；手改 SQL 会与快照脱节（`check` 兜） |
| 6 | 迁移互斥 | `pg_advisory_lock` / `GET_LOCK`，启动自动跑 | 多实例安全 | MySQL 锁随连接断而释放，须同连接 |
| 7 | 会话 | `auth_session` 表 + `HttpOnly; SameSite=Lax` Cookie | JWT 无法吊销 | 每请求一次 DB 查会话（走主键） |
| 8 | 租户解析 | `/t/{slug}/` 前缀，每请求查 `org_membership` | 无反代/DNS 依赖；成员可被踢 | 每请求多一次查询 |
| 9 | 注册四模式 | `svc/registration.mjs` 单入口 + `platform_settings` 30s 缓存 | 新增模式只加一个分支，handler 不动 | 改配置最多 30s 延迟 |
| 10 | 数据范围 | M0 只做 `all` / `own` | `dept` 依赖 `org_dept` 表，M0 没有 | dept 范围推迟到 `org_dept` 落地 |
| 11 | 分页 | 复合游标 `(created_at, id)` + 排序白名单 | OFFSET 深页会慢 | 不能跳页 |
| 12 | 校验 | 手写声明式（≈180 行） | 引 zod = 第三个依赖 | 无嵌套/联合类型 DSL |
| 13 | 前端路由 | 不引 `vue-router`，两视图 `v-if` 切换 | M0 只有登录 + 客户列表 | 页面 ≥3 或需深链接时补 |
| 14 | i18n | `web/i18n/{zh,en}.json` + 40 行 `t()`；服务端错误码同字典 | DESIGN 要求第一天双语；`vue-i18n` 是多余依赖 | 无复数/日期本地化规则 |
| 15 | ID / 时间 | 应用侧 `randomUUID()` / `new Date().toISOString()` UTC | 双库禁用 `RETURNING`、`now()` | 时钟由应用负责 |
| 16 | uuid 列 | PG `uuid` / MySQL `char(36)` | MySQL 无 uuid 类型 | 索引体积略大；不排序故无性能问题 |

---

## 2. 目录树

```
NewERP/
├── package.json              type:module · deps: pg,mysql2 · scripts: start,dev,migrate,test,typecheck
├── tsconfig.json             checkJs, strict, noEmit, allowJs
├── docker-compose.yml        app + pg（mysql 走 profile）
├── config.mjs                环境变量 + .env
├── .env.example
├── cmd/  server.mjs · migrate.mjs
├── http/ router.mjs context.mjs middleware.mjs errors.mjs
│         body.mjs validate.mjs page.mjs static.mjs        （S2/S5/S6 依次补）
├── db/   index.mjs pg.mjs mysql.mjs rebind.mjs migrate.mjs ddl.mjs
├── schema/ platform.mjs party.mjs index.mjs snapshot.json
├── migrations/pg/0001_init.sql · migrations/mysql/0001_init.sql
├── auth/ password.mjs session.mjs perm.mjs scope.mjs tenant.mjs
├── api/  health.mjs auth.mjs party.mjs
├── svc/  registration.mjs party.mjs tenant.mjs audit.mjs
├── store/ user.mjs tenant.mjs session.mjs settings.mjs invite.mjs party.mjs audit.mjs
├── web/  package.json vite.config.js index.html src/{main.js,App.vue,i18n/,views/,api.js}
└── test/ skeleton.test.mjs tenant_guard.test.mjs cross_tenant.test.mjs party.test.mjs migration.test.mjs
```

**行数估算**：http ≈1100 · db ≈350 · schema+ddl+migrate ≈450 · auth ≈400 · party 三层 ≈300 · web ≈600 · test ≈250 → **≈3450 行 / 24 人日**。

---

## 3. 数据流

**请求（以 party 创建为例）**

```
POST /t/acme/api/parties
  middleware: recover → requestId → log → ratelimit → tenant → auth → perm
      tenant: slug → org_tenant → 校验 org_membership → ctx.tenantId
      perm:   party:create 缺失 → 403
  api/party.mjs         解析 body（拒绝未知字段）→ validate（无 SQL）
  svc/party.mjs         withTx:
                          store/party.insert(ctx)      -- SQL 带 $t
                          store/audit.insert(ctx)      -- 同事务
                        提交 → 201
```

**迁移生成**

```
schema/*.mjs ──gen──▶ 归一化结构 ──diff(snapshot.json)──▶ ALTER 语句
                                                    ├──▶ migrations/pg/0007_x.sql
                                                    └──▶ migrations/mysql/0007_x.sql
snapshot.json ← 更新并提交
──up──▶ advisory lock → 按序执行 → 写 schema_migration(version, checksum)
──check──▶ information_schema 归一化 vs schema/*.mjs → 漂移即非零退出
```

---

## 4. 表结构（`0001_init`，12 表）

**全局表（无 `tenant_id`）**

```sql
auth_user(id uuid PK, email text NOT NULL UNIQUE, pwd_hash text, pwd_salt text,
          display_name text, status text, created_at time)
org_tenant(id uuid PK, slug text NOT NULL UNIQUE, name text, status text,
           plan text, join_policy text, created_at time)
platform_settings(setting_key text PK, setting_value text, updated_at time)
login_attempt(id uuid PK, kind text, ident text, ip text, ok bool, at time)
auth_session(id uuid PK, user_id uuid, tenant_id uuid NULL, expires_at time,
             ip text, ua text, created_at time)
schema_migration(version text PK, checksum text, applied_at time)
```

**租户表（复合主键 + `$t`）**

```sql
org_membership(tenant_id uuid, user_id uuid, role_id uuid, status text, joined_at time,
               PRIMARY KEY (tenant_id, user_id))

auth_role(tenant_id uuid, id uuid, code text, name text, scope text,
          PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code))

tenant_invite(tenant_id, id, email, code, role_id, expires_at, used_at, created_by,
              PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code))

party(tenant_id, id, code, name, party_type, tax_no, contact_name, phone, email, addr,
      status, remark, version int, created_at, updated_at,
      PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code),
      INDEX (tenant_id, name), INDEX (tenant_id, party_type, status))

party_contact(tenant_id, id, party_id, name, phone, email, title, is_primary,
      PRIMARY KEY (tenant_id, id),
      FOREIGN KEY (tenant_id, party_id) REFERENCES party (tenant_id, id))

audit_log(tenant_id, id, who_id, module, action, ref_type, ref_id,
          before_json json, after_json json, trace_id, at,
          PRIMARY KEY (tenant_id, id),
          INDEX (tenant_id, at), INDEX (tenant_id, ref_type, ref_id))
```

### 类型映射（`db/ddl.mjs` 唯一处）

| 声明 | PG | MySQL |
|---|---|---|
| `uuid` | `uuid` | `char(36)` |
| `code` | `varchar(64)` | `varchar(64)` |
| `text` | `text` | `text` |
| `money` | `numeric(18,2)` | `decimal(18,2)` |
| `int` | `int` | `int` |
| `bool` | `boolean` | `tinyint(1)` |
| `time` | `timestamptz` | `datetime(3)` |
| `json` | `jsonb` | `json` |

排序规则：PG 串列 `COLLATE "C"`；MySQL 表级 `utf8mb4_0900_ai_ci`。

---

## 5. 纵切计划（7 刀，每刀一条验证）

| 刀 | 内容 | 验证命令 | 人日 |
|---|---|---|---|
| **S1** 骨架 | `package.json` · `http/{errors,context,middleware,router}` · `cmd/server.mjs` · `/healthz` | `curl -s localhost:8080/healthz` + `node --test` | 3 |
| **S2** DB+迁移 | `db/*` · `schema/{platform,party}` · `migrate gen/up/check` · `0001_init.sql` ×2 | `node cmd/migrate.mjs up && node cmd/migrate.mjs check` | 5 |
| **S3** 认证+租户 | scrypt · session · cookie · `auth/{tenant,perm}` · `/api/me` | `curl -c j -d '…' …/api/auth/login` | 5 |
| **S4** 注册四模式 | `platform_settings` + 30s 缓存 · `svc/registration` · `tenant_invite` | 改 `registration.mode` → 30s 后行为变 | 3 |
| **S5** party | `store/party` · `svc/party` · `api/party` · `validate` · 游标分页 | `node --test test/party.test.mjs test/cross_tenant.test.mjs` | 3 |
| **S6** 前端 | Vite + EP · 登录页 · 布局 · 客户列表/表单 · i18n | `cd web && npm run dev` 走通 | 3 |
| **S7** 门禁 | `tenant_guard` 扫描 · 双库 `information_schema` 比对 · CI 矩阵 · compose | `DB_DRIVER=mysql node --test test/` | 2 |
| | | **合计** | **24** |

---

## 6. 被否决的方案

| 方案 | 否决原因 |
|---|---|
| `.ts` + 构建（tsc/tsup） | 违反「无编译无 SDK」贡献门槛；Node 22 类型剥离不支持 enum/decorator |
| 重放已有 SQL 做 diff 生成 | 要写 SQL 解析器（≈800 行），比快照 diff 贵 |
| 手写两份迁移 | 46 表 × 每次变更写两遍 = 长期漂移 |
| RLS / 每租户 schema | MySQL 无 RLS，双库破功 |
| JWT | 无法吊销 |
| 引 zod/ajv | 第三个依赖 |
| 引 vue-router / pinia / vue-i18n | M0 两视图，框架自带能力够 |
| MySQL `uuid()` 或 `BINARY(16)` 主键 | 前者是函数默认值（双库不一致），后者需应用侧编码 |
| 用 `email` 做租户内唯一键而非 `id` | 邮箱可改，外键会动 |

---

## 7. 这次不做什么

| # | 不做 | 什么时候做 |
|---|---|---|
| 1 | 审批引擎、通知中心、outbox worker | M2 |
| 2 | AI 层、`ai_draft` 审批 | M6 |
| 3 | M1 之后的任何表 | 对应里程碑 |
| 4 | `sse` 模块、CORS 中间件 | 有事件源 / 有跨域客户端时（M2、M6） |
| 5 | `upload` + `sys_file` 表 | M1 设计文档附件（偏离 §18 清单，已确认） |
| 6 | `sys_config` / `tenant_quota` / `auth_perm` 三张表 | 出现第一个使用者时 |
| 7 | 配额检查、计费 | v2 |
| 8 | `scope=dept`（部门树） | `org_dept` 落地时 |
| 9 | 邀请码**发邮件** | M2 有通知中心；M0 只生成链接人工转（偏离 §18 清单，已确认） |
| 10 | 数据导出 / 删租户 30 天冷静期 | 有客户提出时 |
| 11 | `cmd/backup.mjs` | 上线演练（F 模式）时写 |
| 12 | 全文检索、JSON 路径查询、部分索引、生成列、`RETURNING`、`now()` | 永不（双库红线） |
| 13 | 多实例部署、Redis、MQ | 单实例不够时 |
