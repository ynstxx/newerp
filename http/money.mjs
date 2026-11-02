import { HttpError, errors } from './errors.mjs'

/**
 * 金额只有一个算法：**按"分"用整数算，BigInt 做中间态，绝不走浮点**。
 * `toFixed(2)` 是错的：1.005 → 1.00（少一分），2.675 → 2.67，大额还会丢有效位。
 * 入库参数一律是 "1234.56" 字符串 —— PG numeric 与 MySQL decimal 都精确解析文本。
 *
 * 原先这套函数只长在 svc/quotation.mjs 里，导致商机/BOM 三个入口各自用浮点，
 * 同一个仓库两套算钱方式；现在收成一份。
 */

/**
 * 输入可以是库里拿到的 "1234.56"，也可以是 JSON 里的 1234.56。
 * 多于两位小数四舍五入（half-up）。
 * @param {unknown} v
 * @param {string} [field] 出错时报哪个字段
 * @returns {number} 整数分
 */
export function centsOf(v, field = 'amount') {
  const s = typeof v === 'string' ? v.trim() : String(v ?? '')
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) throw new HttpError(errors.badRequest, { fields: { [field]: 'money' } })
  const sign = m[1]
  const int = /** @type {string} */ (m[2])
  const frac = /** @type {string} */ (m[3] ?? '')
  const padded = `${frac}000`.slice(0, 3)
  let cents = BigInt(int) * 100n + BigInt(padded.slice(0, 2))
  if (padded[2] >= '5') cents += 1n
  const out = Number(sign ? -cents : cents)
  if (!Number.isSafeInteger(out)) throw new HttpError(errors.badRequest, { fields: { [field]: 'too_large' } })
  return out
}

/**
 * 整数分 → "1234.50"（给 numeric(18,2) 列的参数）
 * @param {number} cents
 */
export function moneyOf(cents) {
  const n = Math.trunc(cents)
  const abs = Math.abs(n)
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
  return n < 0 ? `-${s}` : s
}

/**
 * 分 × 分 → 分，乘积除以 100 后四舍五入（BigInt 中间态，不丢精度）
 * @param {number} a @param {number} b
 */
export function mulCents(a, b) {
  const neg = a < 0 !== b < 0
  const p = BigInt(Math.abs(a)) * BigInt(Math.abs(b))
  const rounded = (p + 50n) / 100n
  const n = Number(rounded)
  return neg ? -n : n
}

/**
 * qty × price → 行金额（分）
 * @param {unknown} qty @param {unknown} price
 */
export function lineAmountCents(qty, price) {
  return mulCents(centsOf(qty, 'qty'), centsOf(price, 'price'))
}
