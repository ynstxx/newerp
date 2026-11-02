/**
 * 租户级系统配置（键值）。与 platform_settings 的区别：
 *   platform_settings → 全局（注册模式、新租户默认套餐），所有租户一份
 *   sys_config        → 每个公司自己的开关，互不影响
 * 自托管一个部署管多家关联公司时，两家公司可以有不同的偏好。
 */
export const tables = [
  {
    name: 'sys_config',
    tenant: true,
    pk: ['tenant_id', 'config_key'],
    cols: [
      { n: 'config_key', t: 'code', notNull: true },
      // 不能是 code(64)：将来放 JSON 或长描述的开关会同时撞 PG 22001 / MySQL 1406
      { n: 'config_value', t: 'text', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
  },
]
