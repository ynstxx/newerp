import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { assertProductionConfig, config } from '../config.mjs'
import { createRouter } from '../http/router.mjs'
import { compose, recover, requestId, log } from '../http/middleware.mjs'
import { createContext } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { health } from '../api/health.mjs'
import { login, logout, me } from '../api/auth.mjs'
import { createInvite, register, registerInfo } from '../api/registration.mjs'
import * as party from '../api/party.mjs'
import * as session from '../auth/session.mjs'
import { tenant } from '../auth/tenant.mjs'

const router = createRouter()
router.get('/healthz', health)
router.post('/api/auth/login', login)
router.post('/api/auth/logout', logout)
router.get('/api/auth/register-info', registerInfo)
router.post('/api/auth/register', register)
router.post('/api/invites', createInvite)
router.get('/api/me', me)
router.get('/api/parties', party.list)
router.post('/api/parties', party.create)
router.get('/api/parties/:id', party.get)
router.patch('/api/parties/:id', party.update)
router.del('/api/parties/:id', party.remove)

/** @type {import('../http/middleware.mjs').Middleware} */
async function authSession(ctx, next) {
  await session.load(ctx)
  await next()
}

/** @type {import('../http/middleware.mjs').Middleware} */
async function dispatch(ctx) {
  const hit = router.resolve(ctx.req.method ?? 'GET', ctx.path)
  if (!hit) throw new HttpError(errors.notFound)
  if ('allow' in hit) {
    ctx.res.setHeader('allow', hit.allow.join(', '))
    throw new HttpError(errors.methodNotAllowed)
  }
  ctx.params = hit.params
  await hit.handler(ctx)
}

// 顺序：recover → requestId → log → 会话 → 租户 → 路由
// DESIGN §5 把租户排在认证前；这里对调，因为 membership 校验需要 userId。
const pipeline = compose([recover, requestId, log, authSession, tenant, dispatch])

export function createApp() {
  return http.createServer((req, res) => {
    void pipeline(createContext(req, res))
  })
}

// 仅直接运行时监听；被测试 import 时不自启
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertProductionConfig()
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
