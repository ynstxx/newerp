/**
 * 出站 HTTP：15s 超时 + 最多 2 次重试（DESIGN §11.5）。
 *
 * 只重试「有意义的失败」：网络错误 / 超时 / 5xx / 429。
 * 4xx 是对方明确拒绝（key 错、收件人不存在），重试 3 次只是把错误延迟 3 倍。
 */

export const TIMEOUT_MS = 15_000
export const MAX_RETRIES = 2

export class ChannelError extends Error {
  /** @param {string} message @param {{ status?: number, body?: string }} [info] */
  constructor(message, info = {}) {
    super(message)
    this.name = 'ChannelError'
    this.status = info.status ?? 0
    this.body = info.body ?? ''
  }
}

/** 可重试：网络错/超时/5xx/429 */
const retriable = (/** @type {number} */ status) => status === 0 || status === 429 || status >= 500

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param {string} url
 * @param {unknown} body
 * @param {{ headers?: Record<string, string>, timeoutMs?: number, retries?: number }} [opts]
 * @returns {Promise<{ status: number, text: string }>}
 */
export async function postJson(url, body, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const tries = (opts.retries ?? MAX_RETRIES) + 1
  /** @type {string} */
  let last = '未发出请求'

  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(200 * i)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    /** @type {number} */
    let status = 0
    /** @type {string} */
    let text = ''
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify(body ?? {}),
        signal: ac.signal,
      })
      status = res.status
      text = await res.text().catch(() => '')
      if (res.ok) return { status, text }
      last = `HTTP ${status} ${text.slice(0, 200)}`
    } catch (err) {
      last = ac.signal.aborted ? `超时 ${timeoutMs}ms` : `请求失败 ${/** @type {Error} */ (err).message}`
    } finally {
      clearTimeout(timer)
    }
    if (!retriable(status)) throw new ChannelError(last, { status, body: text })
  }
  throw new ChannelError(`重试 ${tries} 次仍失败：${last}`)
}
