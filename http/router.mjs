/**
 * 方法 + 分段匹配。`/projects/:id/tasks` 里的 `:id` 捕获一段。
 * 同一路径命中但方法不符 → 返回 allow 列表，由调用方转 405。
 */

/** @typedef {(ctx: any) => Promise<void> | void} Handler */

/** @param {string} p */
const segs = (p) => p.split('/').filter(Boolean)

/**
 * @param {string[]} pattern
 * @param {string[]} parts
 * @returns {Record<string, string> | null}
 */
function match(pattern, parts) {
  if (pattern.length !== parts.length) return null
  /** @type {Record<string, string>} */
  const params = {}
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i]
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(parts[i])
      continue
    }
    if (seg !== parts[i]) return null
  }
  return params
}

export function createRouter() {
  /** @type {{ method: string, segs: string[], handler: Handler }[]} */
  const routes = []

  /** @param {string} method @param {string} path @param {Handler} handler */
  const add = (method, path, handler) => void routes.push({ method, segs: segs(path), handler })

  return {
    add,
    /** @param {string} p @param {Handler} h */
    get: (p, h) => add('GET', p, h),
    /** @param {string} p @param {Handler} h */
    post: (p, h) => add('POST', p, h),
    /** @param {string} p @param {Handler} h */
    put: (p, h) => add('PUT', p, h),
    /** @param {string} p @param {Handler} h */
    patch: (p, h) => add('PATCH', p, h),
    /** @param {string} p @param {Handler} h */
    del: (p, h) => add('DELETE', p, h),

    /**
     * @param {string} method
     * @param {string} pathname
     * @returns {{ handler: Handler, params: Record<string, string> } | { allow: string[] } | null}
     */
    resolve(method, pathname) {
      const parts = segs(pathname)
      /** @type {Set<string>} */
      const allow = new Set()
      for (const r of routes) {
        const params = match(r.segs, parts)
        if (!params) continue
        allow.add(r.method)
        if (r.method === method) return { handler: r.handler, params }
      }
      return allow.size ? { allow: [...allow] } : null
    },
  }
}
