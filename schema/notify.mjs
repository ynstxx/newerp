/**
 * 通知中心（DESIGN §10）。DB 表当队列，不引 MQ/Redis。
 *
 * 队列语义靠 `status + next_retry_at`：
 *   pending  → 到了 next_retry_at 就可以被取
 *   sending  → 已被某个 worker 领走（next_retry_at 同时当租约，5 分钟后可被重领）
 *   sent / failed → 终态
 * 不用 `RETURNING` / `now()` / 自增列，时间一律由应用传 Date。
 */

export const tables = [
  {
    name: 'notify_channel',
    tenant: true,
    cols: [
      { n: 'type', t: 'code', notNull: true },
      { n: 'enabled', t: 'bool', notNull: true },
      // 密钥字段（api_key / webhook / secret …）在写入前由 svc/notify_crypto.mjs 加密
      { n: 'config', t: 'json' },
      { n: 'version', t: 'int', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    // 一个租户每种渠道只配一条
    uniq: [['type']],
  },
  {
    name: 'notify_template',
    tenant: true,
    cols: [
      { n: 'code', t: 'code', notNull: true },
      { n: 'channel', t: 'code', notNull: true },
      { n: 'lang', t: 'code', notNull: true },
      { n: 'subject', t: 'text' },
      { n: 'body', t: 'text', notNull: true },
      { n: 'version', t: 'int', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code', 'channel', 'lang']],
    index: [['channel']],
  },
  {
    name: 'notify_outbox',
    tenant: true,
    cols: [
      { n: 'channel', t: 'code', notNull: true },
      // email → 邮箱；inapp → user id；dingtalk/wecom → 群标识（群机器人是群级，不是人级）
      { n: 'to_addr', t: 'code', notNull: true },
      { n: 'template_code', t: 'code', notNull: true },
      { n: 'vars', t: 'json' },
      { n: 'status', t: 'code', notNull: true },
      { n: 'attempts', t: 'int', notNull: true },
      { n: 'next_retry_at', t: 'time' },
      { n: 'error', t: 'text' },
      // sha256 hex = 64 字符，正好塞进 code(64)
      { n: 'dedupe_key', t: 'code', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    uniq: [['dedupe_key']],
    index: [['status', 'next_retry_at'], ['template_code'], ['created_at', 'id']],
  },
  {
    name: 'notify_inbox',
    tenant: true,
    cols: [
      { n: 'user_id', t: 'uuid', notNull: true },
      { n: 'title', t: 'text', notNull: true },
      { n: 'body', t: 'text' },
      { n: 'link', t: 'code' },
      { n: 'read_at', t: 'time' },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    index: [['user_id', 'read_at', 'created_at'], ['created_at', 'id']],
  },
]
