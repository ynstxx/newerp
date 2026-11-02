import { exec, one, q } from '../db/index.mjs'

// 全局表：平台级键值，无 tenant_id
/** @param {any} ctx */
export const all = (ctx) => q(ctx, `SELECT setting_key, setting_value FROM platform_settings`, [])

/** @param {any} ctx @param {string} key */
export const byKey = (ctx, key) =>
  one(ctx, `SELECT setting_key, setting_value FROM platform_settings WHERE setting_key = $1`, [key])

/**
 * 先 UPDATE，影响 0 行再 INSERT（DESIGN §6.2 禁 upsert 的写法）
 * @param {any} ctx @param {string} key @param {string} value
 */
export async function put(ctx, key, value) {
  const now = new Date()
  const n = await exec(ctx, `UPDATE platform_settings SET setting_value = $1, updated_at = $2 WHERE setting_key = $3`, [
    value,
    now,
    key,
  ])
  if (n === 0) {
    await exec(ctx, `INSERT INTO platform_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, $3)`, [
      key,
      value,
      now,
    ])
  }
}
