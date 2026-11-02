import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { assertProductionConfig, config } from '../config.mjs'
import { readdirSync } from 'node:fs'
import { createRouter } from '../http/router.mjs'
import { compose, recover, requestId, log } from '../http/middleware.mjs'
import { createContext } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { serveStatic } from '../http/static.mjs'
import { health } from '../api/health.mjs'
import { login, logout, me } from '../api/auth.mjs'
import { createInvite, register, registerInfo } from '../api/registration.mjs'
import * as party from '../api/party.mjs'
import * as session from '../auth/session.mjs'
import * as notifyWorker from '../svc/notify_worker.mjs'
import { install as installApprovalNotify } from '../svc/approval_notify.mjs'
import { tenant } from '../auth/tenant.mjs'

/**
 * 路由总表。各业务域把自己的路由放在 api/routes-<域名>.mjs 的 register(router) 里，
 * 这样多人/多 Agent 并行时不必抢改这个文件。
 */
export function buildRouter() {
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
  // 各业务域自动注册
  for (const mod of ROUTE_MODULES) mod.register?.(router)
  return router
}

/**
 * 各业务域自己的路由都放在 api/routes-<域名>.mjs 里，导出 register(router)。
 * 这里自动发现 —— 否则每加一个域就要改这个文件，多人并行时它就成排队点。
 */
const API_DIR = new URL('./', new URL('../api/', import.meta.url))
const ROUTE_MODULES = await Promise.all(
  readdirSync(API_DIR)
    .filter((f) => /^routes-.+\.mjs$/.test(f))
    .sort()
    .map((f) => import(new URL(f, API_DIR).href)),
)

/** @type {import('../http/middleware.mjs').Middleware} */
async function authSession(ctx, next) {
  await session.load(ctx)
  await next()
}

/**
 * @param {any} [router] 可注入路由表（测试时把尚未挂进总表的切片路由接进来）
 */
function makeDispatch(router) {
  /** @type {import('../http/middleware.mjs').Middleware} */
  return async function dispatch(ctx) {
    const hit = router.resolve(ctx.req.method ?? 'GET', ctx.path)
    if (!hit) {
      // 路由没命中再试静态资源（前端构建产物），都没有才 404
      if (await serveStatic(ctx)) return
      throw new HttpError(errors.notFound)
    }
    if ('allow' in hit) {
      ctx.res.setHeader('allow', hit.allow.join(', '))
      throw new HttpError(errors.methodNotAllowed)
    }
    ctx.params = hit.params
    await hit.handler(ctx)
  }
}

// 顺序：recover → requestId → log → 会话 → 租户 → 路由
// DESIGN §5 把租户排在认证前；这里对调，因为 membership 校验需要 userId。
/**
 * @param {any} [router] 可注入路由表（测试时把尚未挂进总表的切片路由接进来）
 */
export function createApp(router = buildRouter()) {
  const pipeline = compose([recover, requestId, log, authSession, tenant, makeDispatch(router)])
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
  // 审批事件 → 通知：挂在 svc 层的事件口子上，业务域自己的 submit 端点也能命中
  installApprovalNotify()
  server.listen(config.port, config.host, () => {
    // 通知 outbox worker：单进程内轮询，DB 当日志队列
    notifyWorker.start()
    console.log(`newerp ${config.version} listening on http://${config.host}:${config.port}`)
  })
  for (const sig of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
    process.on(sig, () => {
      console.log(`${sig} received, draining`)
      notifyWorker.stop()
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(1), 30_000).unref()
    })
  }
}
