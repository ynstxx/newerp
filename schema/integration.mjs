/**
 * 外部集成（钉钉 / 企业微信）。
 * 只放本域自己的三张表：连接配置、外部↔本地映射、同步日志。
 * 人员/部门本身仍落在 org_membership / auth_user（历史单据要留人，不物理删）。
 */

export const tables = [
  {
    name: 'integration_conn',
    tenant: true,
    cols: [
      { n: 'provider', t: 'code', notNull: true }, // dingtalk | wecom
      { n: 'corp_id', t: 'code' },
      { n: 'agent_id', t: 'code' },
      // aes-256-gcm 密文（base64）。永不明文落库、永不回显。
      { n: 'secrets', t: 'json' },
      { n: 'enabled', t: 'bool', notNull: true, default: 'false' },
      { n: 'last_sync_at', t: 'time' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
    ],
    uniq: [['provider']],
    index: [['enabled']],
  },
  {
    name: 'integration_map',
    tenant: true,
    cols: [
      { n: 'provider', t: 'code', notNull: true },
      { n: 'external_type', t: 'code', notNull: true }, // dept | user
      // 外部 id 可能是字符串（企微 userid 最长 64），不能按 uuid 存
      { n: 'external_id', t: 'code', notNull: true },
      // 本地 id：user 是 auth_user.id；dept 暂存外部部门 id（本仓库尚无 org_dept 表）
      { n: 'local_id', t: 'code', notNull: true },
      { n: 'synced_at', t: 'time', notNull: true },
    ],
    uniq: [['provider', 'external_type', 'external_id']],
    index: [['provider', 'external_type', 'local_id'], ['provider', 'external_type']],
  },
  {
    name: 'integration_sync_log',
    tenant: true,
    cols: [
      { n: 'provider', t: 'code', notNull: true },
      { n: 'action', t: 'code', notNull: true },
      { n: 'counts', t: 'json' },
      { n: 'error', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
    ],
    index: [['provider', 'at'], ['at']],
  },
]
