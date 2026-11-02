import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'

/**
 * 托管 web/dist（DESIGN §5：产物托管、ETag、SPA fallback）。
 * 没有预压缩文件就先不做 gzip —— 反代那层做更合适。
 */
const ROOT = new URL('../web/dist/', import.meta.url)

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/**
 * @param {string} rel
 * @returns {Promise<{ path: URL, size: number, mtime: Date } | null>}
 */
async function statOf(rel) {
  // 只允许 dist 下的普通路径，挡掉 ../ 穿越
  if (rel.includes('..')) return null
  const url = new URL(rel.replace(/^\/+/, ''), ROOT)
  if (!url.href.startsWith(ROOT.href)) return null
  try {
    const s = await stat(url)
    return s.isFile() ? { path: url, size: s.size, mtime: s.mtime } : null
  } catch {
    return null
  }
}

/**
 * 命中就写响应并返回 true。调用方只在路由未命中时调用它。
 * @param {any} ctx
 * @returns {Promise<boolean>}
 */
export async function serveStatic(ctx) {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return false
  if (ctx.path.startsWith('/api/') || ctx.path === '/healthz') return false

  let file = await statOf(ctx.path)
  let immutable = false
  if (!file) {
    // 只有"看起来不是文件"的路径才回落 index.html，免得把 404 变成 200
    if (extname(ctx.path)) return false
    file = await statOf('/index.html')
    if (!file) return false
  } else if (ctx.path.startsWith('/assets/')) {
    immutable = true
  }

  const etag = `W/"${file.size.toString(16)}-${file.mtime.getTime().toString(16)}"`
  /** @type {Record<string, string | number>} */
  const headers = {
    'content-type': MIME[extname(file.path.pathname)] ?? 'application/octet-stream',
    etag,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  }
  if (ctx.req.headers['if-none-match'] === etag) {
    ctx.res.writeHead(304, headers)
    ctx.res.end()
    return true
  }
  headers['content-length'] = String(file.size)
  ctx.res.writeHead(200, headers)
  if (ctx.req.method === 'HEAD') {
    ctx.res.end()
    return true
  }
  await new Promise((resolve) => {
    const stream = createReadStream(file.path)
    stream.on('error', () => resolve(undefined))
    stream.on('end', () => resolve(undefined))
    stream.pipe(ctx.res)
  })
  return true
}
