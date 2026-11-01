/**
 * 全局表（无 tenant_id）。主键默认单列 `id`，除非显式声明 `pk`。
 * 约定：`uniq` / `index` 里的列名在 tenant 表上会被自动加上 tenant_id 前缀（DESIGN §4.2）。
 */

export const platformTables = [
  {
    name: 'auth_user',
    tenant: false,
    cols: [
      { n: 'email', t: 'code', notNull: true },
      { n: 'pwd_hash', t: 'text', notNull: true },
      { n: 'pwd_salt', t: 'text', notNull: true },
      { n: 'display_name', t: 'code', notNull: true },
      { n: 'status', t: 'code', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    uniq: [['email']],
  },
  {
    name: 'org_tenant',
    tenant: false,
    cols: [
      { n: 'slug', t: 'code', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'status', t: 'code', notNull: true },
      { n: 'plan', t: 'code', notNull: true },
      { n: 'join_policy', t: 'code', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    uniq: [['slug']],
  },
  {
    name: 'platform_settings',
    tenant: false,
    pk: ['setting_key'],
    cols: [
      { n: 'setting_key', t: 'code', notNull: true },
      { n: 'setting_value', t: 'text', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
  },
  {
    name: 'login_attempt',
    tenant: false,
    cols: [
      { n: 'kind', t: 'code', notNull: true },
      { n: 'ident', t: 'code', notNull: true },
      { n: 'ip', t: 'code' },
      { n: 'ok', t: 'bool', notNull: true },
      { n: 'at', t: 'time', notNull: true },
    ],
    index: [['ident', 'at'], ['ip', 'at']],
  },
  {
    name: 'auth_session',
    tenant: false,
    cols: [
      { n: 'user_id', t: 'uuid', notNull: true },
      { n: 'tenant_id', t: 'uuid' },
      { n: 'expires_at', t: 'time', notNull: true },
      { n: 'ip', t: 'code' },
      { n: 'ua', t: 'text' },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    index: [['user_id'], ['expires_at']],
  },
]

/**
 * 迁移器自己的元数据表：不进 migrations/*.sql（它必须先于迁移存在），
 * 由 db/migrate.mjs 启动时 CREATE TABLE IF NOT EXISTS。
 */
export const metaTable = {
  name: 'schema_migration',
  tenant: false,
  pk: ['version'],
  cols: [
    { n: 'version', t: 'code', notNull: true },
    { n: 'checksum', t: 'code', notNull: true },
    { n: 'applied_at', t: 'time', notNull: true },
  ],
}
