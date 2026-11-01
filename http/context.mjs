/**
 * @typedef {object} Ctx
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {URL} url
 * @property {Record<string, string>} params  路由参数
 * @property {string} requestId
 * @property {number} startedAt
 */

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Ctx}
 */
export function createContext(req, res) {
  return {
    req,
    res,
    url: new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`),
    params: {},
    requestId: '',
    startedAt: Date.now(),
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
