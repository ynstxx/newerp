# 并行切片契约（M2 之后通用）

> 你是一个独立切片。读这三份就够：`docs/DESIGN.md`（铁律）、`docs/PARALLEL-CONTRACT.md`（本文）、
> 以及你自己域相关的那一节。项目技能：`/home/stxx/.pi/agent/projects-memory/NewERP/skills/newerp-add-domain-slice/SKILL.md`

---

## 0. 你只能碰这些

```
schema/<域>.mjs              新建：export const tables = [ ... ]
store/<域>*.mjs              新建
svc/<域>*.mjs                新建
api/<域>*.mjs                新建
api/routes-<域>.mjs          新建：export function register(router)
test/<域>*.test.mjs          新建
docs/<域>-DESIGN.md          新建（可选，记录你自己的取舍）
```

**禁止修改**：`cmd/server.mjs`、`schema/index.mjs`、`db/*`、`http/*`、`auth/*`、`web/src/i18n.js`、
`web/src/App.vue`、`web/src/AppShell.vue`、`package.json`、`migrations/`、其他域的任何文件。

这些共享文件都已经改成**自动发现**，你不需要改它们：

| 共享点 | 怎么自动的 |
|---|---|
| 路由注册 | `cmd/server.mjs` 扫 `api/routes-*.mjs`，调它们的 `register(router)` |
| 表结构聚合 | `schema/index.mjs` 扫 `schema/*.mjs` 的 `tables` 导出；外键按依赖**拓扑排序**，跨域 FK 随便指 |
| 前端文案 | `web/src/i18n.js` 自动合并 `web/src/i18n/*.zh.json` 与 `*.en.json` |
| 权限点 | 直接用字符串（如 `'approval:config'`）调 `need(ctx, 'xxx')`，**不要改 `auth/perm.mjs`** |

---

## 1. 环境（PG 16 @ 127.0.0.1:5433）

```bash
export NODE_ENV=development DB_DRIVER=pg DB_HOST=127.0.0.1 DB_PORT=5433 \
       DB_USER=newerp DB_PASSWORD=newerp DB_NAME=newerp_w_<你的域>

npm i --include=dev --silent
docker exec newerp-pg-1 psql -U newerp -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  docker exec newerp-pg-1 psql -U newerp -d postgres -c "CREATE DATABASE $DB_NAME"

# 生成本域临时迁移（只为你自己跑测试）
node cmd/migrate.mjs gen 990_<你的域>
node cmd/migrate.mjs up
node --test test/<域>*.test.mjs
npx tsc --noEmit
```

**提交前必须清掉迁移产物**（正式迁移由主线统一生成）：

```bash
git checkout HEAD -- schema/snapshot.json
git rm -q --cached migrations/pg/990_*.sql migrations/mysql/990_*.sql 2>/dev/null
rm -f migrations/pg/990_*.sql migrations/mysql/990_*.sql
```

---

## 2. 不可协商

| 规则 | 说明 |
|---|---|
| 租户谓词 | 每条租户表 SQL 必带 `$t`；`ctx.tenantId` 只来自中间件 |
| 分层 | `api/` 无 SQL；`store/` 无业务判断；`svc/` 唯一开事务处 |
| 写操作 | `withTx` + 一条 `audit.insert`（模块名用你的域） |
| 双库禁用 | 禁 `RETURNING` `LAST_INSERT_ID` `now()` `CURRENT_TIMESTAMP` 部分索引 生成列 JSON 路径查询 自增列 |
| ID / 时间 | `crypto.randomUUID()` / `new Date()`（传 Date 对象） |
| 金额 | 用 `http/money.mjs` 的 `centsOf/moneyOf/mulCents`，**不要用浮点**、不要 `toFixed` |
| 状态机 | 用 `svc/transition.mjs` 的 `assertTransition`；`toApi` 里带 `allowed: allowedNext(TRANSITIONS, x.status)` |
| 并发 | 表要有 `version`（或 `lock_version`）列；`UPDATE ... AND version = $n`，0 行 → 409 |
| 越权 | 跨租户一律 **404**（不是 403、不是 400） |
| 分页 | `http/page.mjs` 的 `parsePage` + `cursorClause` + `trimPage`，列表返回 `{items,nextCursor}` |
| 校验 | `http/body.mjs` 的 `only()` + `http/validate.mjs` 的 `validate()`，未知字段 400 |

---

## 3. 测试要求（每片都要）

```js
import { makeApp, jsonOf } from './helpers.mjs'
const app = await makeApp()          // 路由已自动注册，不用传 register
```

必须覆盖：**跨租户 404**、**非法状态跳转 409（带 allowed）**、**未知字段 400**、正常主路径、
以及你这一域特有的边界（金额档、SLA 超时、库存不足、幂等去重……）。

`test.before` 里 `await connect()` 失败就 `t.skip('需要数据库')`；`test.after` 里 `await app.close()`。

---

## 4. 外部服务怎么测

钉钉/企微/短信/邮件的真实 API 一律**不要真连**：用 `node:http` 在本进程起一个假服务器，
把 `base_url` 指过去，断言请求体。仓库不许引入 mock 库。

---

## 5. 收尾

```bash
npx tsc --noEmit && node --test test/<域>*.test.mjs   # 都过
git add -A && git commit -m "feat(<域>): ..."          # 已清掉迁移产物
```

最后一次回复 ≤ 20 行：新增文件、表清单、端点清单、用例数、取舍、以及**你认为主线合并时要注意什么**。
