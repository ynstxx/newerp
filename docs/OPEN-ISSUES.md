# 已知缺口与延后事项

> 记录「发现了但这次没做」的东西，避免烂在对话里。每条都要能回答：为什么现在不做、什么时候做。

## 跨域链路

| # | 缺口 | 现状 | 何时做 |
|---|---|---|---|
| 1 | **钉钉/企微部门 → 本地 `org_dept`** | 集成切片合并时 `org_dept` 还不存在，`integration_map.local_id` 暂存**外部部门 id**；审批切片后来建了 `org_dept`/`org_dept_member`，但两边没接上 | 两片都在手上时补：同步部门时建/更新 `org_dept`（`path` 用外部 id 拼，稳定即可），成员落到 `org_dept_member`；顺带把 `integration_map.local_id` 改成本地 department id |
| 2 | **成员手机号** | `auth_user` 没有 `phone` 列，同步只带姓名/邮箱/状态 | 做短信通知时一起加列（M2 通知切片的短信渠道要用） |
| 3 | **审批结果不触发通知** | 审批切片不依赖通知域，hook 留了口子但没接 | 通知切片合并后，在 `approval_hooks` 里接 `emit('approval.pending')` 等事件 |
| 4 | **`approver_type='field'`** | 未实现（要跨域读 project.pm_user_id 之类） | 有真实需求时按 DESIGN §9.4 补 |

## 功能延后

| # | 项 | 为什么 | 何时做 |
|---|---|---|---|
| 5 | 手写 SMTP 客户端（≈250 行） | 需要真实 SMTP 服务器才能验，假服务器验不出 MIME 编码/中文头的问题 | 有内网自托管客户时 |
| 6 | `tenant_quota` / `sys_file` 两张表 | 仍然没有使用者（配额检查、附件）。`sys_config` 已在第 4 波落地（自动编号开关） | 各自第一个使用者出现时 |
| 7 | `scope='own'/'dept'` 数据范围 | 目前列表只按 `$t` 过滤；`ctx.role.scope` 读了但没用 | 有「只能看自己负责的」真实诉求时（M3/M4 上量后） |
| 8 | 计费 / 订阅 | DESIGN 明确 v1 不做 | v2 |
| 9 | 页码式分页（带总数） | 游标分页没有 total，大表 OFFSET 会慢 | UI 明确要「第 N 页/共 M 条」时，加 `count(*)` 单独接口 |
| 10 | `member` 角色缺 `dispatch`/`approve` | 权限改成模式匹配后，这些动作只有 owner 能做 | 需要「客服主管」「审批人」这类角色时再建角色体系 |

## 技术债

| # | 项 | 说明 |
|---|---|---|
| 11 | 状态历史无幂等唯一键 | `project_stage_log` 只有 `(project_id, at)` 索引。B1/B2 补了 `AND status = from` 之后重复历史实际不可能，暂不加约束 |
| 12 | `stock_move.sn_list` 是冗余字符串 | 一条流水多个 SN 时存 `|SN1|SN2|`，`snTrace` 用 LIKE 匹配。SN 追溯要更细时改成事件表 |
| 13 | 前端未接入成员通讯录到编辑表单 | 列表里已显示姓名，但「项目经理/负责人」编辑框还是手填 uuid |
| 14 | 报价/合同列表的 `q` 只搜 code/name/note | 不搜客户名（要 JOIN party），够用就先不 JOIN |
| 15 | `store/work.mjs` 的 `pageQuery()` 用 `${table}` 动态表名 | 9 张同构表一份 CRUD 助手，表名全部来自同文件常量。租户守卫已放宽为「动态表名 + 没有 `$t` 才拦」，但静态检查看不出是哪张表 —— 新增调用点要人工确认传的是常量 |
| 16 | CI 只跑 PG + MySQL + dual + web 四个作业 | 没有「非 UTC 时区」之外的矩阵维度；`TZ=Asia/Shanghai` 已经在 mysql 作业里 |

---

## 第 4 波审计后新增（状态机 / 并发）

| # | 缺口 | 现状 | 何时做 |
|---|---|---|---|
| 17 | **采购侧钩子失败没有 `onFailed`** | 施工的领料/变更已经实现 `onFailed`（事务回滚 + 单据落 failed）。采购 PO / 分包 / 进度款三条钩子还没实现：钩子抛错时审批实例回滚成 pending、单据停在原状态，需要人工重试 | 下一批：给 `PO_TRANSITIONS` 等加 `failed` 与重试边，再补三个 `onFailed` |
| 19 | 不可达状态被 `allowed` 暴露 | `PO_TRANSITIONS.approved=['closed']`、`MATERIAL_ISSUE_TRANSITIONS.draft=[…,'cancelled']` 等边没有对应端点，前端按 `allowed` 渲染出点不动的按钮 | 补端点，或从 TRANSITIONS 删掉这些边 |
| 20 | `invoice.status` 是死列（永远 `issued`） | 没有作废/红冲路径，也不返回 `allowed` | 做红冲时一起做 |
| 21 | 在途审批缺唯一约束（`(doc_type, doc_id)` 只能一个 pending） | 靠应用层 `pendingInstanceByDoc` 读后写 + 各单据状态守卫拼出来 | 加部分唯一索引（PG `WHERE status='pending'`，MySQL 用生成列——注意生成列在禁用清单里，需重新评估） |
| 22 | 编号空洞 | `code_seq` 自增独立提交，单据随后回滚会留下号码空洞 | 可接受（发票类单据需要连续号时才处理） |

## 第 4 波审计后新增（租户）

| # | 缺口 | 现状 | 何时做 |
|---|---|---|---|
| 23 | **防线二守卫的四处盲区**（审计 G2） | ① `tenant-free` 是纯子串判断，注释里写一句就能整条豁免；② INSERT 例外只看列清单有没有 `tenant_id`，看不到值来自哪；③ 全局表 `auth_user` 完全在扫描范围外 —— 通讯录跨租户改写账户（已修）就是从这里溜过去的 | 收紧为「标记必须带非空理由」+ 增加 `GLOBAL_WRITE` 白名单（写 `auth_user` 必须同函数内有 `memberExists` 或带标记） |
| 24 | 公共 `POST /api/approvals` 不校验单据归属（审计 G1） | 任何成员可为任意（含不存在/别租户的）docId 造审批实例；钩子 0 行静默变幽灵审批，还能按 docId 刷通知 | 加 `verify(docType, ctx, docId)` 注册表，与 `onApproved` 同处；至少先做 docType 白名单 |
| 25 | 缓存与编号缺跨租户回归（审计 G4） | `config` / `codegen` 的用例都是单租户，`code_seq` 唯一键被改成不带 tenant_id 也不会红 | 补「A 关自动编号 → B 仍自动」「A、B 各自从 0001 起」 |
| 26 | 权限点两处疑似漏授（审计 G5） | `stock:move` 与 `ai:chat` 的动作名不在 member 的 `*:view/create/update` 里 → 成员不能手工出入库、不能用 AI 对话 | 确认是否有意；要放开就改成 `stock:create` / `ai:create` |
| 27 | 跨租户外键返回 400 而非 404（审计 G6） | 响应与「陌生 uuid」字节级相同（不泄漏存在性），但与 §4.3「一律 404」不一致；两种风格并存 | 统一成 404 |
| 28 | `POST /api/notify/test` 只要求登录（审计 G7） | 任何成员可用本租户已配的渠道（含群机器人 webhook / SMTP）发真实消息 | 提到 `notify:config` |

## 第 4 波审计后新增（双库）

| # | 缺口 | 现状 | 何时做 |
|---|---|---|---|
| 29 | 删除物料/仓库不做引用检查（审计 B8） | 带引用删除会冒外键错误成 500（两库错误码还不同）；同仓 `store/service_contract.mjs` 的 `refs()` 已有正确范式 | 给 `deleteItem`/`warehouseRemove` 照抄 `refs()`，有引用返回 409 |
| 30 | `notify_outbox` 的领取查询用不上索引（审计 B11） | 三个索引都以 `tenant_id` 打头，worker 是跨租户查 `WHERE status/next_retry_at`，两库都会退化扫描 | 给 outbox 加 `(status, next_retry_at)` 全局索引（生成器需支持非租户前缀的附加索引） |
| 31 | `svc/service_contract` 的 amount 未归一（审计 B9） | 靠 `api/service.mjs` 的 `moneyOfInput` 兜；被内部调用（AI 工具/其它 svc）绕过 api 时，三位小数会直接进 numeric | svc 入口统一 `moneyOf(centsOf(v))` |
