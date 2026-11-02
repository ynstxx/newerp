# 贡献指南

NewERP 的目标是**零 Web 框架、零 ORM、双数据库等权**。贡献代码前请先读
[`docs/DESIGN.md`](docs/DESIGN.md) 和 [`docs/PARALLEL-CONTRACT.md`](docs/PARALLEL-CONTRACT.md)；
本文只列最容易被忽略、但一定会被 CI 或评审拦下的规则。

---

## 1. 环境

- **Node.js ≥ 22**（`package.json` 的 `engines` 已声明）
- Docker + Docker Compose（本地数据库）
- 运行时依赖只有 `pg`、`mysql2` 两个；**不要新增运行时依赖**

```bash
npm i
cp .env.example .env
docker compose up -d              # PostgreSQL 16 → 127.0.0.1:5433
node cmd/migrate.mjs up            # 空库建表
node cmd/migrate.mjs check         # 声明结构 vs 实际库
node cmd/server.mjs                # http://localhost:8080/healthz
```

需要 MySQL 时：

```bash
docker compose --profile mysql up -d    # MySQL 8.0 → 127.0.0.1:3308
DB_DRIVER=mysql DB_PORT=3308 node cmd/migrate.mjs up
DB_DRIVER=mysql DB_PORT=3308 node cmd/migrate.mjs check
```

开发时可以用 `node --watch cmd/server.mjs`；前端在 `web/`，见 README。

---

## 2. 硬门槛：跨租户越权用例

**新功能 PR 必须附一条跨租户用例，并且断言 404。**

- 不是 403，不是 400。403 会告诉攻击者“这个对象存在”。
- 用例要真的建 A、B 两个租户，用 B 的凭证访问 A 的对象；只测“B 访问自己的对象”不算。
- 新接口至少覆盖：读、改、删/终止里最危险的那条路径。
- 现有范例：`test/party.test.mjs`、`test/item.test.mjs`、`test/ai.test.mjs`、`test/approval.test.mjs`。

典型形状（用 `test/helpers.mjs` 的 `makeApp` / `jsonOf`）：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeApp } from './helpers.mjs'

test('跨租户读 A 的记录 → 404', async () => {
  const app = await makeApp()
  try {
    // 建 A、B 两租户，分别登录拿 cookieA / cookieB，并在 A 里建一条记录 idA
    const res = await app.call('GET', `/t/${slugB}/api/xxx/${idA}`, undefined, cookieB)
    assert.equal(res.status, 404)
  } finally {
    await app.close()
  }
})
```

没有这条用例的 PR 不会被合并。租户守卫 `test/tenant_guard.test.mjs` 只是第二道网，抓不到“SQL 带了 `$t` 但业务上把 id 用错”的问题。

---

## 3. 双库纪律

PostgreSQL 16+ 和 MySQL 8.0+ **等权**，CI 两个都跑。以下写法一律禁止：

| 禁用 | 原因 |
|---|---|
| `RETURNING` / `LAST_INSERT_ID()` | 两边行为不同；ID 由应用侧 `crypto.randomUUID()` 生成 |
| `now()` / `CURRENT_TIMESTAMP` | 时区与精度不可控；统一传 `new Date()` |
| 部分索引（`WHERE` 条件的索引） | MySQL 无对应能力 |
| 生成列 | 双库语义与限制不同 |
| JSON 路径查询（`->>`、`JSON_EXTRACT` 等） | 只整存整取，保双库一致 |
| 自增列 | 主键统一 `(tenant_id, id)`，ID 应用侧生成 |

另外：

- **时间**：统一传 `Date` 对象，不要传格式化字符串。
- **金额**：用 `http/money.mjs` 的 `centsOf` / `moneyOf` / `mulCents`；**不要用浮点**，不要 `toFixed`。
- **并发**：业务表要有 `version`（或 `lock_version`）；`UPDATE ... AND version = $n`，影响 0 行返回 409。
- **分页**：用 `http/page.mjs` 的 `parsePage` + `cursorClause` + `trimPage`，列表返回 `{items, nextCursor}`。
- **校验**：用 `http/body.mjs` 的 `only()` + `http/validate.mjs` 的 `validate()`，未知字段返回 400。

---

## 4. 分层铁律

| 层 | 规则 |
|---|---|
| `api/` | **无 SQL**。只做 HTTP 解析、权限、调用 `svc`、返回 JSON |
| `store/` | **无业务判断**。只拼 SQL、执行、返回行；租户表 SQL 必带 `$t` |
| `svc/` | **唯一开事务的地方**。业务规则、状态机、跨表写入在这里；写操作 `withTx` + 一条 `audit.insert` |

补充：

- `ctx.tenantId` 只能来自 `auth/tenant.mjs` 中间件，handler 不得自行接收/覆盖。
- 跨租户一律 404；状态机非法跳转 409；未知字段 400。
- 状态迁移用 `svc/transition.mjs` 的 `assertTransition`，`toApi` 里带 `allowed: allowedNext(...)`。
- 写操作必须留审计，`module` 用你的域。

---

## 5. 改表流程（唯一流程）

1. 改 `schema/*.mjs`（表结构单真源，不要手写 DDL）。
2. 生成迁移：

   ```bash
   node cmd/migrate.mjs gen 000N_xxx
   ```

   会同时生成 `migrations/pg/000N_xxx.sql` 与 `migrations/mysql/000N_xxx.sql`，并更新 `schema/snapshot.json`。

3. **两份 SQL 都提交**，外加 `schema/snapshot.json`；评审要能直接读到 SQL。
4. 在空库/开发库执行 `node cmd/migrate.mjs up`，再 `node cmd/migrate.mjs check`。
5. **不要手改已应用的迁移文件**。迁移器存了 checksum，改了会直接报错；要修正就新增 `000N+1_*.sql`。

注意：给已有数据的表加 `NOT NULL` 列时必须给默认值（生成器支持 `default`），否则迁移会失败。升级细节见 [`docs/UPGRADE.md`](docs/UPGRADE.md)。

---

## 6. 提交前自检清单

```bash
# PostgreSQL
DB_DRIVER=pg    DB_PORT=5433 node cmd/migrate.mjs check
DB_DRIVER=pg    DB_PORT=5433 npm test

# MySQL（先 docker compose --profile mysql up -d）
DB_DRIVER=mysql DB_PORT=3308 node cmd/migrate.mjs check
DB_DRIVER=mysql DB_PORT=3308 npm test

# 类型与租户守卫（不需要数据库）
npm run typecheck
node --test test/tenant_guard.test.mjs
```

`npm test` 是 `node --test --test-concurrency=1`，**两个驱动各跑一遍**才算过。
如果用例依赖数据库而库不可用，测试会 `t.skip('需要数据库')`；这种情况下不要把“跳过”当成“通过”。

PR 描述里请写清：改了什么、为什么、跨租户用例在哪、两个驱动是否都跑过。
