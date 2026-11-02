/**
 * 出站请求统一入口：15s 超时 + 最多 2 次重试（含首次共 3 次）。
 * 不引入任何 HTTP 库；node:fetch 足够，也方便测试把 base_url 指到本地假服务器。
 */

const TIMEOUT_MS = 15_000
const RETRIES = 2

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const retries = opts.retries ?? RETRIES
  /** @type {unknown} */
  let lastErr = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      // 4xx 是调用方的问题，重试没意义；5xx 可能是对端抖动，重试
      if (res.status < 500) return res
      lastErr = new Error(`上游返回 ${res.status}`)
      await res.arrayBuffer().catch(() => {})
    } catch (err) {
      lastErr = err
    } finally {
      clearTimeout(timer)
    }
    if (attempt < retries) await sleep(100 * (attempt + 1))
  }
  throw lastErr instanceof Error ? lastErr : new Error('出站请求失败')
}

/**
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @param {{ timeoutMs?: number, retries?: number }} [opts]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, init = {}, opts = {}) {
  const res = await fetchWithRetry(url, init, opts)
  const text = await res.text()
  /** @type {any} */
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`上游返回的不是 JSON（HTTP ${res.status}）`)
  }
  if (!res.ok) throw new Error(`上游 HTTP ${res.status}`)
  return data
}
