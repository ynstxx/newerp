import { exec, one, q } from '../db/index.mjs'

// 租户表：键值配置
/** @param {any} ctx */
export const all = (ctx) => q(ctx, `SELECT config_key, config_value FROM sys_config WHERE $t`, [])

/** @param {any} ctx @param {string} key */
export const byKey = (ctx, key) =>
  one(ctx, `SELECT config_key, config_value FROM sys_config WHERE $t AND config_key = $1`, [key])

/**
 * 先 UPDATE，影响 0 行再 INSERT（DESIGN §6.2 禁 upsert）
 * @param {any} ctx @param {string} key @param {string} value
 */
export async function put(ctx, key, value) {
  const now = new Date()
  const n = await exec(ctx, `UPDATE sys_config SET config_value = $1, updated_at = $2 WHERE $t AND config_key = $3`, [
    value,
    now,
    key,
  ])
  if (n === 0) {
    await exec(
      ctx,
      `INSERT INTO sys_config (tenant_id, config_key, config_value, updated_at) VALUES ($1, $2, $3, $4)`,
      [ctx.tenantId, key, value, now],
    )
  }
}
