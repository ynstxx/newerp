# M1 切片实现契约（给并行 Agent）

> 你是其中一个切片。读 `docs/DESIGN.md`（铁律）、`docs/M1-DESIGN.md`（本次定案）、
> `docs/M1-AGENT-CONTRACT.md`（本文）三份就够了，不要读别的东西。
> 项目技能：`/home/stxx/.pi/agent/projects-memory/NewERP/skills/newerp-add-domain-slice/SKILL.md`

---

## 0. 你只能碰这些文件

新建（只允许新建，不改别人的）：

```
store/<实体>.mjs      svc/<实体>.mjs      api/<实体>.mjs
api/routes-<切片>.mjs   test/m1_<切片>.test.mjs
```

**禁止修改**：`schema/` `migrations/` `docs/` `package.json` `http/` `db/` `auth/`
`cmd/` `web/` 以及任何别的切片的文件。表已经建好了（`0002_m1_project_chain`，22 表），
**不要生成迁移**。

---

## 1. 环境（PG 16，本机 Docker）

```bash
export NODE_ENV=development DB_DRIVER=pg DB_HOST=127.0.0.1 DB_PORT=5433 \
       DB_USER=newerp DB_PASSWORD=newerp DB_NAME=newerp_m1_<你的切片>

npm i --silent
docker exec newerp-pg-1 psql -U newerp -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  docker exec newerp-pg-1 psql -U newerp -d postgres -c "CREATE DATABASE $DB_NAME"

node cmd/migrate.mjs up          # 建 22 张表
node --test test/m1_<切片>.test.mjs
```

每个切片用**自己的数据库**，互不干扰。收尾报告里贴出这条测试的通过数。

---

## 2. 不可协商的写法

| 规则 | 说明 |
|---|---|
| 租户谓词 | 每条租户表 SQL 必带 `$t`；`ctx.tenantId` 只来自中间件 |
| `api/` 无 SQL | handler 只做：`need()` → `only()`/`validate()` → 调 svc → `sendJson` |
| `store/` 无业务判断 | 纯 SQL；动态条件只拼白名单常量，值一律 `$n` 参数 |
| `svc/` 唯一开事务 | `withTx(ctx, tx => …)`，写操作跟一条 `audit_log` |
| 双库禁用 | 禁 `RETURNING` `LAST_INSERT_ID` `now()` `CURRENT_TIMESTAMP` 部分索引 生成列 JSON 路径查询 |
| ID / 时间 | `crypto.randomUUID()` / `new Date()`（传 Date 对象，不要传 ISO 字符串给 MySQL） |
| 并发 | 表都有 `version int`；PATCH 带 `version` 显式校验 + `UPDATE … WHERE version = $n` 兜底 |
| 状态机 | 用 `svc/transition.mjs` 的 `assertTransition(name, TRANSITIONS, from, to)`，非法跳转 409 |
| 错误 | `throw new HttpError(errors.conflict, { reason: '…' })`；越权 403、跨租户/不存在 404 |

---

## 3. 路由约定

在 `api/routes-<切片>.mjs` 导出：

```js
export function register(router) {
  router.get('/api/xxx', xxx.list)
  router.post('/api/xxx', xxx.create)
}
```

路径**不带** `/t/{slug}` 前缀（租户中间件已把它剥掉）。

---

## 4. 测试怎么写

用 `test/helpers.mjs`：

```js
import { makeApp, jsonOf } from './helpers.mjs'
import { register } from '../api/routes-a.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { exec, q } from '../db/index.mjs'

let app
test.before(async () => { app = await makeApp(register) /* 建两个租户 A、B 并登录 */ })
test.after(() => app.close())
// app.call('POST', `/t/${slugA}/api/xxx`, body, cookieA)
```

- `test.before` 里 `await connect()` 失败要 `t.skip('需要数据库')`
- 造前置数据（别的切片的表）**用自己写的直连 SQL**，不要 import 别人的 store：
  `await exec({ tenantId }, 'INSERT INTO project (…) VALUES (…)', [...])`
- **必须有一条跨租户用例**：用 B 的 cookie 读/改 A 的资源 → 断言 **404**（不是 403）
- 必须有一条非法状态跳转用例 → 断言 **409**
- 必须有一条「未知字段被拒」或字段校验用例 → 断言 **400**

---

## 5. 收尾

```bash
npx tsc --noEmit                      # 必须干净
node --test test/m1_<切片>.test.mjs   # 必须全绿
git add -A && git commit -m "feat(m1-<切片>): …"
```

提交信息写清楚：做了哪些端点、状态机、用例数。

---

## 6. 各切片规格

### A · 商机 + 立项（表：opportunity / project / project_stage_log）

```
POST   /api/opportunities             {code,name,partyId,ownerId?,estAmount,expectedSignAt?,note?}  201
GET    /api/opportunities             ?stage=&q=&limit=&cursor=  → {items,nextCursor}
GET    /api/opportunities/:id
PATCH  /api/opportunities/:id         {version,…}
POST   /api/opportunities/:id/advance {to, note?}
GET    /api/projects                  ?status=&q=&limit=&cursor=
GET    /api/projects/:id
PATCH  /api/projects/:id              {version, name?, pmUserId?, startDate?, endDate?, note?}
POST   /api/projects/:id/advance      {to, note?}
GET    /api/projects/:id/stages       → 状态变更历史
```

- 商机状态机 `{ new:['following','lost'], following:['won','lost'], won:[], lost:[] }`
- 项目状态机 `{ draft:['approved','terminated'], approved:['designing','terminated'],
  designing:['quoting','approved','terminated'], quoting:['signed','designing','terminated'],
  signed:[], terminated:[] }`
- `won` 时**同事务**建 project：`status='draft'`、`code='P-'+商机code`、`party_id` 继承、
  `contract_amt=0`、`opportunity_id` 指向来源；并写一条 `project_stage_log(from=null,to='draft')`
- 每次项目状态变更写 `project_stage_log(project_id, from_status, to_status, actor_id, note, at)`
- `terminated` 走 `PERM.projectTerminate`
- 纯文本字段用 `code` 类型（varchar 64）注意长度

### B · 需求 + 方案 BOM（表：requirement / design_doc / bom_line）

```
POST   /api/requirements        {projectId,title,content?}          201
GET    /api/requirements        ?projectId=&status=
PATCH  /api/requirements/:id    {version,title?,content?}
POST   /api/requirements/:id/advance {to:'confirmed'}
POST   /api/design-docs         {projectId,title,content?,bomLines:[{lineNo,itemName,spec?,uom?,qty,unitCost,note?}]}
GET    /api/design-docs         ?projectId=
GET    /api/design-docs/:id     → 含 bomLines
PATCH  /api/design-docs/:id     {version,bomLines?,content?}   仅 draft
POST   /api/design-docs/:id/advance {to:'confirmed'}
```

- 状态机 `{ draft:['confirmed'], confirmed:[] }`（requirement 与 design_doc 各一张）
- `design_doc.version` = 该项目已有方案数 +1（租户内按 project_id 取 max）
- `bomLines` 整批替换语义：PATCH 带 bomLines 就删旧行插新行（同事务）
- `qty/unitCost` 用 money，行金额由应用侧算 `qty*unitCost` 存进…（本表无 amount 列，不存）
- 项目不存在 → 404（用 `$t` 查 project 表；不 import 别人的 store）

### C · 报价（表：quotation / quotation_line）

```
POST   /api/quotations        {designDocId, validUntil?, priceLines?:[{lineNo,price}]}   201
GET    /api/quotations        ?projectId=&status=&limit=&cursor=
GET    /api/quotations/:id    → 含 lines
POST   /api/quotations/:id/advance {to}
```

- 状态机 `{ draft:['sent'], sent:['accepted','rejected'], accepted:[], rejected:[] }`
- **从 BOM 快照**：读 `design_doc` + `bom_line`（自己写只读 SQL），逐行拷
  `item_name/spec/uom/qty`，`price` 取 `priceLines` 指定值否则用 `bom_line.unit_cost`，
  `amount = qty * price`（四舍五入到 2 位，用整数分算再除，避免浮点）
- `quotation.code` 由调用方给不了时自动生成：`Q-<design_doc_id 前 8 位>-<版本>`；
  或要求传 `code` 也行 —— 二选一，但要在测试里覆盖唯一冲突 409
- `party_id` 从 project 继承；`amount` = 各行 amount 之和
- `version` = 该项目已有报价数 +1（不是表内唯一键，允许重复）
- 设计文档必须已 `confirmed` 才能出报价，否则 409

### D · 合同（表：contract / contract_line / contract_term）

```
POST   /api/contracts         {quotationId, code, name, signAt?, terms?:[{seq,title,content}]}  201
GET    /api/contracts         ?projectId=&status=&limit=&cursor=
GET    /api/contracts/:id     → 含 lines + terms
POST   /api/contracts/:id/advance {to:'signed'}
```

- 状态机 `{ draft:['signed'], signed:[] }`
- **从报价快照**：读 `quotation` + `quotation_line`（自己写只读 SQL），拷
  `item_name/spec/uom/qty/price/amount`；`amount` = 报价金额；`party_id` 继承
- 报价必须 `accepted` 才能签合同，否则 409
- `signed` 时**同事务**把自己的 `sign_at` 写上，并把 `project.status` 直接改成 `signed`
  （`UPDATE project SET status='signed', version=version+1, updated_at=$n WHERE $t AND id=$n`），
  同时补一条 `project_stage_log(from='quoting', to='signed', note='合同签署')`
- `terms` 可空；`seq` 从 1 递增
