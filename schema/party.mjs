/**
 * 业务表（全部 tenant_id，复合主键 (tenant_id, id)）。
 * `uniq` / `index` / `fk` 声明里只写业务列，tenant_id 由生成器补在最前。
 * 外键永远复合指向 (tenant_id, id) —— 跨租户引用在物理上不可能。
 */

export const tables = [
  {
    name: 'org_membership',
    tenant: true,
    pk: ['tenant_id', 'user_id'],
    cols: [
      { n: 'user_id', t: 'uuid', notNull: true },
      { n: 'role_id', t: 'uuid' },
      { n: 'status', t: 'code', notNull: true },
      { n: 'joined_at', t: 'time', notNull: true },
    ],
  },
  {
    name: 'auth_role',
    tenant: true,
    cols: [
      { n: 'code', t: 'code', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'scope', t: 'code', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
  },
  {
    name: 'tenant_invite',
    tenant: true,
    cols: [
      { n: 'email', t: 'code', notNull: true },
      { n: 'code', t: 'code', notNull: true },
      { n: 'role_id', t: 'uuid' },
      { n: 'expires_at', t: 'time' },
      { n: 'used_at', t: 'time' },
      { n: 'created_by', t: 'uuid' },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['email']],
  },
  {
    name: 'party',
    tenant: true,
    cols: [
      { n: 'code', t: 'code', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'party_type', t: 'code', notNull: true },
      { n: 'tax_no', t: 'code' },
      { n: 'contact_name', t: 'code' },
      { n: 'phone', t: 'code' },
      { n: 'email', t: 'code' },
      { n: 'addr', t: 'text' },
      { n: 'status', t: 'code', notNull: true },
      { n: 'remark', t: 'text' },
      { n: 'version', t: 'int', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['name'], ['party_type', 'status'], ['created_at', 'id']],
  },
  {
    name: 'party_contact',
    tenant: true,
    cols: [
      { n: 'party_id', t: 'uuid', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'phone', t: 'code' },
      { n: 'email', t: 'code' },
      { n: 'title', t: 'code' },
      { n: 'is_primary', t: 'bool', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    index: [['party_id']],
    fk: [{ cols: ['party_id'], ref: 'party' }],
  },
  {
    name: 'audit_log',
    tenant: true,
    cols: [
      { n: 'who_id', t: 'uuid' },
      { n: 'module', t: 'code', notNull: true },
      { n: 'action', t: 'code', notNull: true },
      { n: 'ref_type', t: 'code' },
      { n: 'ref_id', t: 'uuid' },
      { n: 'before_json', t: 'json' },
      { n: 'after_json', t: 'json' },
      { n: 'trace_id', t: 'code' },
      { n: 'at', t: 'time', notNull: true },
    ],
    index: [['at'], ['ref_type', 'ref_id']],
  },
]
