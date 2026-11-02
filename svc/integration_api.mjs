import { fetchJson } from './integration_http.mjs'
import { apiBase, normalizeProvider } from './integration_providers.mjs'

/**
 * 钉钉/企微的 HTTP 形状集中在这里。errcode≠0 一律抛错，由 sync 落日志。
 * @param {any} data @param {string} label
 */
function assertOk(data, label) {
  const code = Number(data?.errcode ?? 0)
  if (code !== 0) throw new Error(`${label}失败：${data?.errmsg ?? `errcode=${code}`}`)
  return data
}

/**
 * @param {unknown} provider
 * @param {Record<string, any>} secrets
 * @param {string} [base]
 */
export async function accessToken(provider, secrets, base) {
  const p = normalizeProvider(provider)
  const root = apiBase(p, base)
  if (p === 'dingtalk') {
    if (!secrets.appkey || !secrets.appsecret) throw new Error('钉钉集成缺少 appkey / appsecret')
    const url = `${root}/gettoken?appkey=${encodeURIComponent(secrets.appkey)}&appsecret=${encodeURIComponent(secrets.appsecret)}`
    const data = assertOk(await fetchJson(url), '钉钉 gettoken')
    if (!data.access_token) throw new Error('钉钉 gettoken 未返回 access_token')
    return String(data.access_token)
  }

  if (!secrets.corpsecret) throw new Error('企业微信集成缺少 corpsecret')
  const corpId = secrets.corpid ?? secrets.corp_id ?? ''
  const url = `${root}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secrets.corpsecret)}`
  const data = assertOk(await fetchJson(url), '企业微信 gettoken')
  if (!data.access_token) throw new Error('企业微信 gettoken 未返回 access_token')
  return String(data.access_token)
}

/**
 * @param {unknown} provider
 * @param {string} token
 * @param {string} [base]
 * @returns {Promise<{ id: string, name: string, parentId: string | null }[]>}
 */
export async function listDepartments(provider, token, base) {
  const p = normalizeProvider(provider)
  const root = apiBase(p, base)
  const url =
    p === 'dingtalk'
      ? `${root}/department/list?access_token=${encodeURIComponent(token)}`
      : `${root}/cgi-bin/department/list?access_token=${encodeURIComponent(token)}`
  const data = assertOk(await fetchJson(url), '拉取部门')
  const list = Array.isArray(data.department) ? data.department : []
  return list.map((/** @type {any} */ d) => ({
    id: String(d.id),
    name: String(d.name ?? d.id),
    parentId: d.parentid === undefined || d.parentid === null ? null : String(d.parentid),
  }))
}

/**
 * @param {unknown} provider
 * @param {string} token
 * @param {string} departmentId
 * @param {string} [base]
 */
export async function listUsers(provider, token, departmentId, base) {
  const p = normalizeProvider(provider)
  const root = apiBase(p, base)
  const url =
    p === 'dingtalk'
      ? `${root}/user/list?access_token=${encodeURIComponent(token)}&department_id=${encodeURIComponent(departmentId)}`
      : `${root}/cgi-bin/user/list?access_token=${encodeURIComponent(token)}&department_id=${encodeURIComponent(departmentId)}`
  const data = assertOk(await fetchJson(url), '拉取成员')
  return Array.isArray(data.userlist) ? data.userlist : []
}

/**
 * 扫码登录：code → 外部 userid。只认外部身份，绝不在这里建本地账号。
 * @param {unknown} provider
 * @param {string} token
 * @param {string} code
 * @param {string} [base]
 * @returns {Promise<string>}
 */
export async function exchangeUser(provider, token, code, base) {
  const p = normalizeProvider(provider)
  const root = apiBase(p, base)

  if (p === 'dingtalk') {
    const url = `${root}/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(token)}`
    const data = assertOk(
      await fetchJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      '钉钉 code 换 userid',
    )
    const userid = data.result?.userid ?? data.userid
    if (!userid) throw new Error('钉钉未返回 userid')
    return String(userid)
  }

  const url = `${root}/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(token)}&code=${encodeURIComponent(code)}`
  const data = assertOk(await fetchJson(url), '企业微信 code 换 userid')
  if (!data.userid) throw new Error('企业微信未返回 userid（可能是非企业成员）')
  return String(data.userid)
}
