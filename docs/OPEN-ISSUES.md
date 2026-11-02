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
| 6 | `tenant_quota` / `sys_config` / `sys_file` 三张表 | 仍然没有使用者（配额检查、租户级配置、附件） | 各自第一个使用者出现时 |
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
| 15 | CI 只跑 PG + MySQL + dual + web 四个作业 | 没有「非 UTC 时区」之外的矩阵维度；`TZ=Asia/Shanghai` 已经在 mysql 作业里 |
