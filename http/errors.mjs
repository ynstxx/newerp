/** 错误定义：code 供前端分支，zh/en 供人看，status 供 HTTP */
/**
 * @typedef {{ code: string, status: number, zh: string, en: string }} ErrDef
 */

/** @type {Record<string, ErrDef>} */
export const errors = {
  badRequest: { code: 'bad_request', status: 400, zh: '请求无效', en: 'Bad request' },
  notFound: { code: 'not_found', status: 404, zh: '不存在', en: 'Not found' },
  methodNotAllowed: { code: 'method_not_allowed', status: 405, zh: '方法不允许', en: 'Method not allowed' },
  internal: { code: 'internal', status: 500, zh: '服务器繁忙', en: 'Internal error' },
}

export class HttpError extends Error {
  /**
   * @param {ErrDef} def
   * @param {unknown} [details]
   */
  constructor(def, details) {
    super(def.en)
    this.code = def.code
    this.status = def.status
    this.zh = def.zh
    this.en = def.en
    this.details = details
  }
}

/** @param {import('node:http').IncomingHttpHeaders} headers */
export function langOf(headers) {
  return String(headers['accept-language'] ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh'
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {ErrDef} def
 * @param {string} requestId
 * @param {unknown} [details]
 */
export function sendError(res, def, requestId, details) {
  if (res.headersSent) return void res.destroy()
  /** @type {{ error: { code: string, message: string, details?: unknown } }} */
  const body = { error: { code: def.code, message: langOf(res.req?.headers ?? {}) === 'en' ? def.en : def.zh } }
  if (details !== undefined) body.error.details = details
  const json = JSON.stringify({ ...body, requestId })
  res.writeHead(def.status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  })
  res.end(json)
}
