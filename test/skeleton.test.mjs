import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createRouter } from '../http/router.mjs'
import { createApp } from '../cmd/server.mjs'
import { close } from '../db/index.mjs'

/**
 * @param {any} hit
 * @returns {{ handler: Function, params: Record<string, string> }}
 */
const narrow = (hit) => {
  assert.ok(hit && 'params' in hit)
  return hit
}

test('路由：静态、参数、404、405', () => {  const r = createRouter()
  r.get('/healthz', () => {})
  r.get('/api/parties/:id', () => {})

  assert.deepEqual(narrow(r.resolve('GET', '/healthz')).params, {})
  assert.deepEqual(narrow(r.resolve('GET', '/api/parties/abc')).params, { id: 'abc' })
  assert.equal(r.resolve('GET', '/nope'), null)
  assert.deepEqual(r.resolve('POST', '/healthz'), { allow: ['GET'] })
  // 段数不符不算命中
  assert.equal(r.resolve('GET', '/api/parties'), null)
})

test('骨架：/healthz 200，未知路径 404，方法不符 405', async (t) => {
  const server = createApp().listen(0, '127.0.0.1')
  await once(server, 'listening')
  // /healthz 会真的连库，连出来的连接池必须在跑完关掉，否则进程不退出
  t.after(async () => {
    server.close()
    await close()
  })
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address())
  const base = `http://127.0.0.1:${addr.port}`

  const ok = await fetch(`${base}/healthz`)
  const body = /** @type {any} */ (await ok.json())
  assert.equal(ok.status, 200)
  assert.ok(['up', 'down'].includes(body.db), `db 状态异常: ${body.db}`)
  assert.equal(body.ok, body.db === 'up', 'ok 必须与 db 一致')
  assert.match(ok.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/)

  const missing = await fetch(`${base}/api/nope`)
  assert.equal(missing.status, 404)
  assert.equal(/** @type {any} */ (await missing.json()).error.code, 'not_found')

  const wrongMethod = await fetch(`${base}/healthz`, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'GET')
})
