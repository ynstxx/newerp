import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import * as config from './config.mjs'
import * as seq from '../store/code_seq.mjs'

/**
 * 单据编号自动生成：`PREFIX-YYYY-0001`，按租户 × 前缀 × 年度递增。
 *
 * 并发：每次自增在**独立事务**里做（UPDATE 拿行锁），撞唯一键就整体重试 ——
 * 不能在同一个事务里 catch 后重试：PG 一旦报错，事务就 aborted 了。
 *
 * @param {any} ctx
 * @param {string} prefix 如 PO / QUO / TK，2-4 个大写字母
 * @returns {Promise<string>}
 */
export async function nextCode(ctx, prefix) {
  // 租户可以在「系统设置」里关掉自动编号 —— 有些客户有自己的编码体系
  if (!(await config.isCodeAuto(ctx))) {
    throw new HttpError(errors.badRequest, {
      reason: '已关闭自动编号，请手工填写单据编号（系统设置 → 自动编号）',
      fields: { code: 'required' },
    })
  }
  const p = String(prefix).toUpperCase()
  const year = String(new Date().getUTCFullYear())
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const n = await withTx(ctx, (tx) => seq.bump(tx, { prefix: p, period: year, now: new Date() }))
      return `${p}-${year}-${String(n).padStart(4, '0')}`
    } catch (err) {
      const e = /** @type {any} */ (err)
      const dup = String(e?.code ?? '') === '23505' || Number(e?.errno) === 1062 || e?.code === 'ER_DUP_ENTRY'
      if (!dup) throw err
      lastError = err // 并发首建撞车，重试一次就会走 UPDATE 分支
    }
  }
  throw lastError ?? new Error('编号生成失败')
}

/** 各单据的编号前缀，集中一处，避免各切片自己拍 */
export const PREFIX = {
  partyCustomer: 'CUS',
  partySupplier: 'SUP',
  partyBoth: 'BP',
  opportunity: 'OPP',
  project: 'PRO',
  quotation: 'QUO',
  contract: 'CON',
  item: 'ITM',
  warehouse: 'WH',
  priceBook: 'PB',
  workPlan: 'WP',
  workTask: 'WT',
  materialIssue: 'MI',
  changeOrder: 'CO',
  acceptance: 'ACC',
  laborHour: 'LH',
  purchaseOrder: 'PO',
  goodsReceipt: 'GRN',
  subcontract: 'SUB',
  invoice: 'INV',
  ticket: 'TK',
  serviceContract: 'SC',
  approvalFlow: 'AF',
}
