/** 当前公司 slug。只在登录成功后设置，所有业务请求都带它。 */
let slug = ''

export function setTenant(next) {
  slug = next ?? ''
}

export function currentTenant() {
  return slug
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {{ tenant?: boolean }} [opts] tenant: false 时不加 /t/{slug} 前缀
 */
async function request(method, path, body, opts = {}) {
  const tenant = opts.tenant !== false
  const url = tenant && slug ? `/t/${slug}${path}` : path
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? res.statusText)
    err.status = res.status
    err.code = data?.error?.code
    err.details = data?.error?.details
    throw err
  }
  return data
}

export const api = {
  /** @param {string} path @param {{ tenant?: boolean }} [opts] */
  get: (path, opts) => request('GET', path, undefined, opts),
  /** @param {string} path @param {unknown} body @param {{ tenant?: boolean }} [opts] */
  post: (path, body, opts) => request('POST', path, body ?? {}, opts),
  /** @param {string} path @param {unknown} body */
  patch: (path, body) => request('PATCH', path, body),
  /** @param {string} path @param {unknown} body */
  put: (path, body) => request('PUT', path, body),
  /** @param {string} path */
  del: (path) => request('DELETE', path),
}

/** 把后端字段错误翻成人话（validate.mjs 返回 {fields:{...}}） */
export function fieldErrors(err) {
  const fields = err?.details?.fields
  if (!fields) return err?.details?.reason ?? err?.message ?? '出错了'
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('；')
}
