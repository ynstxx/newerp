import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { once } from 'node:events'
import { createApp } from '../cmd/server.mjs'
import { close } from '../db/index.mjs'

const DIST = new URL('../web/dist/', import.meta.url)
const hasBuild = existsSync(new URL('index.html', DIST))

test('静态托管：index / 带 hash 的产物 / SPA 回落 / ETag 304', async (t) => {
  if (!hasBuild) return t.skip('没有 web/dist，先 cd web && npm run build')

  const server = createApp().listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.close()
    await close()
  })
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`

  const index = await fetch(`${base}/`)
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await index.text(), /<div id="app">/)

  // 真实的产物文件
  const assets = await readdir(new URL('assets/', DIST))
  const js = assets.find((f) => f.endsWith('.js'))
  assert.ok(js, 'dist/assets 里应该有 js')
  const asset = await fetch(`${base}/assets/${js}`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/)
  const etag = asset.headers.get('etag') ?? ''
  assert.match(etag, /^W\//)

  const again = await fetch(`${base}/assets/${js}`, { headers: { 'if-none-match': etag } })
  assert.equal(again.status, 304)

  // 前端深链接回落 index.html
  const deep = await fetch(`${base}/parties/some/deep/link`)
  assert.equal(deep.status, 200)
  assert.match(deep.headers.get('content-type') ?? '', /text\/html/)

  // 有扩展名却不存在 → 404，不冒充 SPA
  assert.equal((await fetch(`${base}/missing.js`)).status, 404)
  // API 路径不会掉进静态兜底
  assert.equal((await fetch(`${base}/api/nope`)).status, 404)
})

test('构建产物没有把后端敏感串打进前端', async (t) => {
  if (!hasBuild) return t.skip('没有 web/dist，先 cd web && npm run build')
  const assets = await readdir(new URL('assets/', DIST))
  const js = assets.filter((f) => f.endsWith('.js'))
  for (const f of js) {
    const code = await readFile(new URL(`assets/${f}`, DIST), 'utf8')
    assert.doesNotMatch(code, /dev-only-insecure-secret/, `${f} 泄漏了默认密钥`)
  }
})
