# 交接文档

> 写给下一个会话的 ARCH（角色定义见 `docs/ROLE.md`）。
> 权威设计是 `docs/DESIGN.md`（v0.4），本文只记录**它落地成了什么样**、**哪些地方和文档不同**、**哪里会踩坑**。
> 生成时间：DESIGN 的七个里程碑全部落地之后。

---

## 1. 一句话状态

**M0–M7 全部落地**：75 张表、16 支迁移、183 个用例（PG / MySQL 双绿）、后端 + 前端闭环、第 4 波审计（越权 / 双库 / 状态机）已修完。

```
94 次提交 · 后端 30,577 行 · 前端 14,348 行 · 29 个测试文件
PG 183/183 · MySQL 183/183 · tsc 干净 · 双库结构等价
```

---

## 2. 三分钟跑起来

```bash
cd /home/stxx/NewERP
npm i
docker compose up -d                  # Postgres 16 → 127.0.0.1:5433
cp .env.example .env                  # 本机 8080 被 Pi Web 占，.env 里 PORT=8099
node cmd/migrate.mjs up               # 建表
npm run seed                          # 演示公司 + 一份能看的业务数据（幂等）
node cmd/server.mjs                   # 起服务
```

打开 **http://192.168.1.245:8099/** · `boss@demo.cn` / `demo12345`

> 操作机在局域网内，**不要给 localhost 链接**，一律用 `192.168.1.245`。

第二库：

```bash
docker compose --profile mysql up -d  # MySQL 8.0 → 127.0.0.1:3308
DB_DRIVER=mysql DB_PORT=3308 node cmd/migrate.mjs up
DB_DRIVER=mysql DB_PORT=3308 npm test
```

---

## 3. 已经有什么

| 里程碑 | 内容 | 落点 |
|---|---|---|
| M0 | 手写 HTTP 层、双库适配、迁移生成器、认证/租户/权限、四模式注册、`party` CRUD | `http/` `db/` `auth/` |
| M1 | 商机→立项→需求→BOM→报价→合同，状态机不可跳级 | `svc/{opportunity,project,requirement,design,quotation,contract}.mjs` |
| M2 | 审批引擎（有序链 + 金额档 + 快照）、通知中心（outbox 队列 + worker）、站内信/邮件/钉钉/企微 | `svc/{approval,notify,notify_worker,approval_notify}.mjs` |
| M3 | 施工计划/任务/进度、领料（走审批 + 扣库存）、变更签证、验收、工时 | `svc/{work,material_issue,change_order,acceptance}.mjs` |
| M4 | 采购/收货/分包/应收应付/收付款/成本归集/**项目毛利** | `svc/purchase.mjs` |
| M5 | 服务合同、工单 + SLA（挂起暂停计时）、派工、巡检、备件、满意度 | `svc/{ticket,sla,service_contract,maintenance}.mjs` |
| M6 | AI 工具层（write 工具**结构上没有 `run`**）、草稿→人审→落库、离线降级 | `svc/ai_*.mjs` |
| M7 | 钉钉/企微通讯录同步、扫码登录、群机器人 | `svc/integration_*.mjs` |

前端 17 个页面，统一骨架 `web/src/components/PageTemplate.vue`（五槽：左上搜索/右上按钮/中间列表或表单/左下提示/右下分页）。

---

## 4. 代码地图

```
cmd/server.mjs        入口（buildRouter 自动扫 api/routes-*.mjs）
cmd/migrate.mjs       gen | up | check
cmd/tenant.mjs        建公司 + owner（首个账号的引导口）
cmd/user.mjs          放行/停用账号（平台级 CLI）
cmd/demo-seed.mjs     演示数据（npm run seed）
cmd/backup.mjs        pg_dump / mysqldump 封装

http/     router context middleware body validate errors page cookie static money
db/       index(pg|mysql 适配) rebind ddl(类型映射+diff) migrate
schema/   表结构唯一真源；index.mjs 自动扫 *.mjs 的 tables 导出 + 外键拓扑排序
auth/     password session tenant perm
api/      薄 handler；每个域一个 routes-<域>.mjs 导出 register(router)
svc/      业务规则 + 状态机 + 唯一开事务处
store/    原生 SQL，一域一文件，租户表必须带 $t
web/src/  AppShell(菜单/顶栏/页签) PageTemplate(页面骨架) views/ i18n/<域>.<lang>.json
```

**三个共享文件已经做成自动发现**，新增业务域不用改它们 —— 这是并行开发的前提：

| 共享点 | 怎么自动 |
|---|---|
| 路由注册 | 扫 `api/routes-*.mjs` |
| 表结构聚合 | 扫 `schema/*.mjs` 的 `tables`，外键按依赖拓扑排序 |
| 前端文案 | `web/src/i18n.js` 合并 `i18n/*.zh.json` 与 `*.en.json` |

---

## 5. 和 DESIGN 文档的差异（都要知道）

| # | DESIGN 说 | 实际 | 为什么 |
|---|---|---|---|
| 1 | Node + **TypeScript** | `.mjs` + JSDoc，`tsc --noEmit` 只检查不产出 | §14「无编译无 SDK」；要真 TS 时接 Node 22 类型剥离 |
| 2 | 迁移手写两份 | `schema/*.mjs` → `gen` 生成两份 SQL，**两份都提交** | 手写 46 表 × 每次变更 = 必然漂移 |
| 3 | 中间件顺序 租户→认证 | **认证→租户** | membership 校验需要 `userId` |
| 4 | 切租户轮换会话 ID | 未做；`auth_session.tenant_id` 只记录不鉴权 | 会话不绑租户 → 没有会话固定面 |
| 5 | `scope=own/dept` 数据范围 | **只做了 `all`** | `dept` 依赖 `org_dept`；`own` 见 OPEN-ISSUES #7 |
| 6 | 分批做 M0→M7 | 一次性把七个里程碑全铺了，靠 3-4 波并行 Agent | 追求速度；代价见 OPEN-ISSUES |
| 7 | 通知用 outbox 表 | 一致；额外加了 `sending` 状态的**租约**（worker 崩了能重领） | 否则 worker 挂掉的消息永久卡住 |
| 8 | 数据字典（未提） | **新增只读字典接口** `GET /api/meta/dicts` | 前端硬编码枚举会漂移；**不建表**，因为状态枚举是状态机的编译期常量 |

---

## 6. 最容易违反的 8 条铁律

| 铁律 | 违反的后果 |
|---|---|
| 租户表 SQL 必带 `$t` | 跨租户泄漏；CI 有源码扫描门禁（`test/tenant_guard.test.mjs`） |
| 不要引入第 3 个运行时依赖 | 现在只有 `pg`、`mysql2`（前端 `@element-plus/icons-vue` 也算 UI 库，别再引别的） |
| 双库禁用：`RETURNING`/`LAST_INSERT_ID`/`now()`/`CURRENT_TIMESTAMP`/部分索引/生成列/JSON 路径/自增 | 两库行为分裂；`test/dual_db.test.mjs` 有静态检查 |
| 时间一律传 `Date` 对象 | MySQL `datetime(3)` 不接受 ISO 串 |
| 金额一律走 `http/money.mjs`（分 + BigInt） | `toFixed` 会少一分（`1.005 → 1.00`） |
| `code` 校验类型只给业务编码 | 名称/分类/单位用 `code` 会把中文全拒掉（踩过 3 次：`baseUom`、`category`） |
| 跨租户一律 **404**（不是 403） | 403 泄漏"这个对象存在" |
| 状态只能经 `advance`/`assertTransition` 改 | `allowed` 与前端按钮全靠这张表 |

---

## 7. 这一段踩过的坑（按类型分组，都会再踩）

### 环境类

| 坑 | 结论 |
|---|---|
| 本机 **8080 被 Pi Web 占**、3306/3307 被别的 ERP 占 | 本项目用 **8099 / 5433 / 3308**，写在本机 `.env`（gitignored） |
| 沙箱 shell 的 `PATH` 不含 `/usr/sbin` | `command -v iptables` 会谎报"未安装"，判断系统工具要用绝对路径 |
| 沙箱进程环境有 `PORT=8080` | 脚本里读 `process.env.PORT` 会连到 Pi Web；`cmd/demo-seed.mjs` 已改成打印目标地址 |
| `node --test test/` 在 Node 22.23 报 `Cannot find module` | 用 `node --test`（自动发现），已在 `package.json` |
| 测试共享一个库且会改全局配置 | `npm test` 必须 `--test-concurrency=1` |
| 多 Agent 并行时**必须各自用独立 `DB_NAME`** | 否则一个 Agent 在跑迁移、另一个在跑双库比对 → 误报失败（真实发生过） |
| `npm i` 默认 `omit=dev`（某些环境） | worktree 里跑 `tsc` 前用 `npm i --include=dev` |

### 代码类（都已修，但会以别的形式复现）

| 坑 | 结论 |
|---|---|
| MySQL 默认 REPEATABLE READ，PG 是 READ COMMITTED | `db/mysql.mjs` 每条连接显式 `SET SESSION ... READ COMMITTED` |
| mysql2 默认 `timezone:'local'` | 库里存的是本地墙钟，往返自洽所以测试看不出来；显式 `timezone:'Z'` |
| `affectedRows` 语义押在 mysql2 默认 flag 上 | 显式 `flags:['FOUND_ROWS']` |
| PG 事务一旦报错就 aborted，`catch` 里继续写库会抛 25P02 | **失败补偿必须放到事务外新开事务**（审批钩子失败走这条路） |
| `$t` 展开成裸 `tenant_id`，JOIN 两张带 tenant_id 的表 → ambiguous | 一条 SQL 只让一张租户表参与，或全走 `$t` |
| 乐观锁拿业务版号兼职 | `design_doc.version` 是"第几版方案"，改内容它不变 → 单开 `lock_version` |
| 派生编码靠截断 | `P-<商机code>` 超长会算出同一个 code，改用短哈希后缀 |
| 前端表单字段串了一个 `//` 注释把逗号吃掉 | 改配置项时 `code: {...} // 注释,` 会让对象字面量语法错 |

---

## 8. 已知问题

全部在 **`docs/OPEN-ISSUES.md`（29 条）**，每条都有「现状 + 何时做」。按我的判断排序：

| 优先 | 编号 | 问题 | 为什么排这个位置 |
|---|---|---|---|
| **高** | #7 | `scope=own/dept` 完全没做，任何成员能看全公司数据 | DESIGN §8 明确要求；M3/M4 上量后这是真问题 |
| 中 | #24 | 公共 `POST /api/approvals` 不校验单据归属 | 任何成员可为任意 docId 造审批实例 |
| 中 | #23 | 租户守卫仍是文本匹配（`isMember` 出现即放行） | 该升级成 AST |
| 中 | #30 | `notify_outbox` 领取查询用不上索引 | worker 是跨租户查，会全表扫 |
| 低 | #9/#10 | 页码分页、平台管理后台 | 现在游标够用、CLI 够用 |

---

## 9. 下一个会话怎么开始

三个候选，按推荐顺序：

**A. 做 `scope=own/dept`（数据范围）** —— DESIGN 里唯一完全没实现的能力。
需要先定：哪些表加 `owner_user_id`、`scope` 怎么拼进 `WHERE`（`auth/scope.mjs` 是空的）、`dept` 要不要等 `org_dept`。
建议先出 A 模式设计（决策表 + 被否决方案），再动代码。

**B. 你上手点一轮界面**，把实际问题攒一批。
界面已验证能跑通全链路，但**没有人真正用过** —— 实际操作的别扭（字段顺序、必填项、错误提示位置）只有用的人知道。

**C. 补采购侧的补偿与台账并发**（OPEN-ISSUES #17 已修，剩下 #18 的后续项都已修完；现在主要是 #30 索引）。

### 开工前的固定动作

1. 读 `docs/ROLE.md`（角色）+ `docs/DESIGN.md`（约束）+ 本文件
2. 读 `docs/OPEN-ISSUES.md`（别把已知项当新发现）
3. 判定模式（A/B/C/D/E/F/G），按该模式的交付物和硬门槛走
4. 写文件前给【判断/方案/代价/默认】，等确认

---

## 10. 命令速查

```bash
npm run dev                    # --watch 起服务
npm run seed                   # 演示数据（幂等）
npm run typecheck              # tsc --noEmit
npm test                       # 183 用例（串行）
DB_DRIVER=mysql DB_PORT=3308 npm test

node cmd/migrate.mjs gen 0017_x   # 改完 schema 后生成两份 SQL
node cmd/migrate.mjs up           # 应用
node cmd/migrate.mjs check        # 声明 vs 实际库，漂移即非零退出
node cmd/tenant.mjs create --slug acme --name "ACME" --email a@b.c --password xxx
node cmd/settings.mjs set registration.mode open   # 四模式：closed|invite|email|open
node cmd/backup.mjs               # 产出 backups/*.sql（已 gitignore）
```

### 关键约定

- 改表：改 `schema/*.mjs` → `gen` → **两份 SQL 都提交** → `up` → `check`。**不要手改已应用的迁移**（checksum 会拦）。
- 新增业务域：`schema/<域>.mjs` + `store/svc/api` + `api/routes-<域>.mjs`（导出 `register`）+ `test/<域>.test.mjs` + `web/src/i18n/<域>.{zh,en}.json`。
- 项目技能：`newerp-add-domain-slice`（`~/.pi/agent/projects-memory/NewERP/skills/`），加表照它走一遍。
- 并行契约：`docs/PARALLEL-CONTRACT.md`（后端）、`docs/FRONTEND-CONTRACT.md`（前端）。

---

## 11. 如果要接着做多 Agent 并行

这一轮用 3 波并行 Agent 完成了 M2–M7 + 前端 + 审计，经验：

| 做对的 | 做错的 |
|---|---|
| 先把三个共享文件改成自动发现，再并行 | 没强制每个 Agent 用独立 `DB_NAME` → 两个 Agent 抢同一个库，误报失败 |
| 文件白名单写死（`docs/*-CONTRACT.md`） | 有一个 Agent 忘了 `git commit`，靠"worktree 保留"才没丢 |
| 让 Agent 自己写迁移再删掉、主线统一 `gen` | Agent 报告里的"失败"要自己核实（有一半是并行干扰或旧快照） |
| 审计发现里区分「修 / 记账 / 否掉」 | 我第一版修 S2 时没让事务回滚，反而制造了新的半落账 |

**给 Agent 的 prompt 里必须写死**：独立 `DB_NAME`、最后一步是 `git commit`、外部服务不能真连（用 `node:http` 起假服务器）。
