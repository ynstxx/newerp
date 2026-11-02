/**
 * @typedef {object} Ctx
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {URL} url
 * @property {string} path              租户前缀剥离后的路径，路由按它匹配
 * @property {Record<string, string>} params  路由参数
 * @property {string} requestId
 * @property {number} startedAt
 * @property {string} [sessionId]
 * @property {string | null} [userId]
 * @property {string | null} [tenantId] 只由 auth/tenant.mjs 赋值，永不来自请求体
 * @property {{ id: string, slug: string, name: string, plan: string }} [tenant]
 * @property {{ code: string, scope: string }} [role]
 * @property {Set<string>} perms
 */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Ctx}
 */
export function createContext(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  return {
    req,
    res,
    url,
    path: url.pathname,
    params: {},
    requestId: '',
    startedAt: Date.now(),
    userId: null,
    tenantId: null,
    perms: new Set(),
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}
