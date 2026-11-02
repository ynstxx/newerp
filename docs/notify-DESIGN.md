# 通知中心 · 本切片的取舍（DESIGN §10 落地记录）

> 只记录**和 DESIGN 字面不完全一样**的地方，以及后来人最容易踩的坑。
> 表/端点清单见文末。

## 1. 队列语义：`status + next_retry_at` 双用途

| status | 含义 |
|---|---|
| `pending` | 等到 `next_retry_at`（为空 = 立即可取）就被 worker 取 |
| `sending` | 已被取走；`next_retry_at` 此时当**租约**（默认 5 分钟） |
| `sent` / `failed` | 终态 |

`claimOutbox` 的 WHERE 同时匹配「到期 pending」与「租约过期的 sending」：

```sql
WHERE ((status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= $1))
    OR (status = 'sending' AND next_retry_at <= $1))
ORDER BY created_at, id LIMIT 20 FOR UPDATE SKIP LOCKED
```

这样 worker 崩在「已领走、未回写」之间，5 分钟后消息能被别的实例重领 —— 不会出现消息永久卡在
`sending`。代价是长投递（15s × 3 次重试 = 45s）远小于租约，不会误重领；如果以后渠道超时变长，
`leaseMs` 要跟着抬。

**唯一一条不带 `$t` 的 SQL 就是这条**（worker 是跨租户的系统级消费者，必须一轮取所有租户），
代码里写了 `/* tenant-free */` 标记，`test/tenant_guard` 会检查；其余语句全部 `$t`，
取出来之后按 `row.tenant_id` 派生每行的租户上下文。

## 2. `dedupe_key` 多带一个收件人（**与 DESIGN §10.4 不同，有意为之**）

DESIGN 写的是 `sha256(tenant|channel|template|docId|step)`。按字面实现会有一个硬伤：
同一张单据的两个收件人、同一渠道 → 撞同一个键 → 第二个人被当成「重复」直接丢掉。
通知只发给一个人，比重复发一遍严重得多。

因此实际是 `sha256(tenant|channel|template|docId|step|to_addr)`，`step` 仍然可传，
用于「同一单据同一模板的第二轮提醒」。副作用：`docs.dedupe_key` 长度 64 = sha256 hex，正好塞进 `code(64)`。

## 3. 收件人与渠道的组合规则

- 渠道候选 = `inapp`（永远算候选，缺模板会落 `failed` 暴露出来）
  ∪ 该租户已启用且配过的渠道 ∪ 该事件已配模板的渠道。
  这样「渠道开着但模板没配」不会被静默跳过，而是 outbox 里一行 `failed` + `error='模板缺失：…'`。
- `{ userId }` → 校验 `auth_user` 存在**且是本租户 active 成员**（`auth_user` 是全局表，复合外键保护不到）。
- `{ role }` → `org_membership ⋈ auth_role` 的有效成员。
- `{ field: 'project.pm_user_id' }` → `store.FIELD_READERS` 白名单，每个字段**一行写死的 SQL**。
  绝不拼接表名/列名：拼表名的文件会被 `test/tenant_guard` 直接判死，而且那是唯一能把注入口子开出来的写法。
- 群机器人（dingtalk/wecom）是**群级**投递，不按人复制：每次 emit 只产生一行，`to_addr='group'`。
- 站内信 / 邮件的 `to_addr` 分别是 user id / 邮箱（≤64 字符，邮箱超长会被截断——正常邮箱不会）。

## 4. 模板渲染在 emit 时完成

`notify_outbox` 没有 `lang` 列，而模板可能有多语言。为了不在 worker 里再猜一次语言，
emit 时就把 `{{var}}` 渲染好，把结果放进 `vars` 的保留键：

```
vars = { ...调用方 vars, docType, docId, event, _subject, _body, _link }
```

worker 直接取 `_subject/_body/_link` 投递，不再查模板。副作用：模板在入队后修改不会影响已入队的消息
（对通知来说这是想要的：事件发生时的事实快照）。不认识的占位符原样保留，界面上一眼就能看出模板写错了。

## 5. 渠道与密钥

- `type ∈ inapp|email|dingtalk|wecom`，每个租户每种一条（`uniq(tenant_id,type)`）。
- 密钥字段（`api_key/apiKey/api_secret/apiSecret/webhook/secret/sign/token/password`）用
  **aes-256-gcm** 加密存，格式 `v1.<iv>.<tag>.<ct>`（base64url），密钥由 `APP_SECRET` scrypt 派生。
  换 `APP_SECRET` = 已存密钥全部失效，这是有意的。
- 非密钥配置（`base_url` / `path` / `from` / `timeout_ms`）明文存：后台要展示、排障要看。
- 对外只有 `publicConfig()`：密钥字段**整个键都不出现**，只给 `config.configured=true`。
  `PUT` 是**合并**语义（值传 `null` 表示删除该键），所以前端不需要把已有的密钥回传。
- **SMTP 手写邮件不在本切片**：只做 `channel.type='email'` 的 HTTP API（Resend 兼容：
  `POST {base_url}/emails` + `Authorization: Bearer`）。SMTP 会单独加 `svc/notify_email_smtp.mjs`，
  `deliver()` 的渠道接口不用动。

## 6. 重试与告警

退避表 `1m/5m/15m/1h/6h`，`attempts+1` 后写 `next_retry_at`；`attempts` 到 5 → `failed` +
给本租户 `owner` 角色每人一条站内信（标题「通知发送失败」）。告警**不经 outbox**，否则失败会自己喂自己。

出站 HTTP：15s 超时 + 最多 2 次重试（`svc/notify_http.mjs`）。只重试网络错/超时/5xx/429；
4xx 是对方明确拒绝（key 错、收件人不存在），重试 3 次只是把错误延迟 3 倍。

## 7. 端点

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/notify/inbox` | 本人（未读优先，游标分页，返回 `unread`） |
| POST | `/api/notify/inbox/:id/read` | 本人（不是本人的 → 404） |
| POST | `/api/notify/inbox/read-all` | 本人 |
| GET | `/api/notify/channels` | `notify:config` |
| POST | `/api/notify/channels` | `notify:config`（本切片新增：总得有地方能建第一条渠道） |
| PUT | `/api/notify/channels/:id` | `notify:config`（带 `version` 时走乐观锁，冲突 409） |
| GET | `/api/notify/templates` | `notify:config` |
| POST | `/api/notify/templates` | `notify:config`（同上，创建用） |
| PUT | `/api/notify/templates/:id` | `notify:config`（`code`/`channel` 不可改，会打乱幂等键） |
| POST | `/api/notify/test` | 登录即可，发一条测试消息给本人，失败原因原样回 |

站内信游标为什么不用 `http/page.mjs`：`parsePage` 只认 `created_at|id` 二元游标，而站内信的排序键是
`(read_at IS NULL, created_at, id)` 三元组。硬凑会在 `parsePage` 里被判成非法游标 400。
所以 `api/notify.mjs` 自己解析 `limit`/`cursor`，SQL 侧仍是行比较 keyset（PG 行比较 / MySQL 8 行构造器，
两库语义一致，已验证），不用 OFFSET。

## 8. worker 生命周期

`svc/notify_worker.mjs` 导出 `createWorker({intervalMs,batch,leaseMs,clock})` 与单例
`start()/stop()/runOnce()`。`start()` 注册 `SIGTERM/SIGINT` 一次性处理器，`stop()` 清 timer、
摘掉信号处理器、等在途的那一轮跑完（优雅退出）；timer 带 `unref()`，不会拖着进程不退出。
`clock` 可注入，测试用它把时间推到 `next_retry_at` 之后验证退避，不用真等 1 分钟。

`cmd/server.mjs` 没动（契约禁止）。要跑消费者：
`node svc/notify_worker.mjs`，或在主线里 `import { start } from './svc/notify_worker.mjs'`。
轮询间隔可用 `NOTIFY_WORKER_INTERVAL_MS` 覆盖（默认 2000）。
