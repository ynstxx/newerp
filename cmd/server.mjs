import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { config } from '../config.mjs'
import { createRouter } from '../http/router.mjs'
import { compose, recover, requestId, log } from '../http/middleware.mjs'
import { createContext } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { health } from '../api/health.mjs'

const router = createRouter()
router.get('/healthz', health)

/** @type {import('../http/middleware.mjs').Middleware} */
async function dispatch(ctx) {
  const hit = router.resolve(ctx.req.method ?? 'GET', ctx.url.pathname)
  if (!hit) throw new HttpError(errors.notFound)
  if ('allow' in hit) {
    ctx.res.setHeader('allow', hit.allow.join(', '))
    throw new HttpError(errors.methodNotAllowed)
  }
  ctx.params = hit.params
  await hit.handler(ctx)
}

const pipeline = compose([recover, requestId, log, dispatch])

export function createApp() {
  return http.createServer((req, res) => {
    void pipeline(createContext(req, res))
  })
}

// 仅直接运行时监听；被测试 import 时不自启
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApp()
  server.on('error', (err) => {
    console.error(`listen ${config.host}:${config.port} failed:`, err.message)
    process.exit(1)
  })
  server.listen(config.port, config.host, () => {
    console.log(`newerp ${config.version} listening on http://${config.host}:${config.port}`)
  })
  for (const sig of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
    process.on(sig, () => {
      console.log(`${sig} received, draining`)
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(1), 30_000).unref()
    })
  }
}
