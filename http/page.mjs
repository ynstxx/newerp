import { HttpError, errors } from './errors.mjs'

/**
 * 游标分页。游标 = base64url(`<ISO时间>|<id>`)，只能沿 created_at 排序 ——
 * 换排序键就要换游标键，那是另一套；M0 不做（按名字排序等 M1 再说）。
 * ponytail: 行比较 (created_at, id) < (?, ?) 两库都支持，不需要 OFFSET 也不需要窗口函数
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** @param {string} s */
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')
/** @param {string} s */
const dec = (s) => Buffer.from(s, 'base64url').toString('utf8')

/**
 * @param {any} ctx
 * @param {{ defaultLimit?: number, maxLimit?: number }} [opts]
 */
export function parsePage(ctx, opts = {}) {
  const qp = ctx.url.searchParams
  const limit = Math.min(Math.max(Number(qp.get('limit')) || opts.defaultLimit || 20, 1), opts.maxLimit || 100)
  const order = /** @type {'asc' | 'desc'} */ (String(qp.get('order') ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc')

  /** @type {{ at: Date, id: string } | null} */
  let cursor = null
  const raw = qp.get('cursor')
  if (raw) {
    const [at, id] = dec(raw).split('|')
    const date = new Date(at ?? '')
    // id 必须是 uuid：直接透传会让 PG 把它当 uuid 推断失败，冒成 500
    if (!UUID.test(id ?? '') || Number.isNaN(date.getTime())) {
      throw new HttpError(errors.badRequest, { reason: 'cursor 无效' })
    }
    cursor = { at: date, id }
  }
  return { limit, order, cursor }
}

/**
 * 游标条件。调用方直接拿返回的 args 继续往下拼。
 * @param {{ at: Date, id: string } | null} cursor
 * @param {unknown[]} args
 * @param {'asc'|'desc'} order
 * @param {string} [col]
 * @returns {{ sql: string, args: unknown[] }}
 */
export function cursorClause(cursor, args, order, col = 'created_at') {
  if (!cursor) return { sql: '', args }
  const next = [...args, cursor.at, cursor.id]
  const op = order === 'asc' ? '>' : '<'
  return { sql: ` AND (${col}, id) ${op} ($${next.length - 1}, $${next.length})`, args: next }
}

/**
 * 多取一条判断还有没有下一页
 * @param {any[]} rows
 * @param {number} limit
 */
export function trimPage(rows, limit) {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: hasMore && last ? enc(`${new Date(last.created_at).toISOString()}|${last.id}`) : null,
  }
}
