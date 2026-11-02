import { once } from 'node:events'
import { buildRouter, createApp } from '../cmd/server.mjs'
import { close } from '../db/index.mjs'

/**
 * 测试用的最小应用：总路由 + 尚未挂进总表的切片路由。
 * 用法：
 *   const app = await makeApp(register)   // register 来自 api/routes-x.mjs
 *   const cookie = await app.login(email, password)
 *   await app.call('GET', `/t/${slug}/api/xxx`, undefined, cookie)
 * @param {(router: any) => void} [register]
 */
export async function makeApp(register) {
  const router = buildRouter()
  if (register) register(router)
  const server = createApp(router).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address())
  const base = `http://127.0.0.1:${addr.port}`

  /** @param {Response} res */
  const cookiesOf = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')

  return {
    server,
    base,
    cookiesOf,
    /** @param {string} email @param {string} password */
    async login(email, password) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (res.status !== 200) throw new Error(`登录失败 ${res.status}`)
      return cookiesOf(res)
    },
    /**
     * @param {string} method
     * @param {string} path 已含 /t/{slug} 前缀
     * @param {unknown} [body]
     * @param {string} [cookie]
     */
    call(method, path, body, cookie) {
      return fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
    async close() {
      server.close()
      await close()
    },
  }
}

/** @param {any} res */
export const jsonOf = async (res) => /** @type {any} */ (await res.json())
