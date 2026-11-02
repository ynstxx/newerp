/**
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} name
 * @param {string} value
 * @param {{ maxAge?: number, secure?: boolean, path?: string, sameSite?: string }} [opts]
 */
export function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path ?? '/'}`]
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`)
  parts.push('HttpOnly', `SameSite=${opts.sameSite ?? 'Lax'}`)
  if (opts.secure) parts.push('Secure')
  const prev = res.getHeader('set-cookie')
  const list = prev ? (Array.isArray(prev) ? prev.map(String) : [String(prev)]) : []
  res.setHeader('set-cookie', [...list, parts.join('; ')])
}
