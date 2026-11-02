import { need, needUser } from '../auth/perm.mjs'
import { only, readJson } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/approval.mjs'
import * as bridge from '../svc/approval_notify.mjs'

// 审批流程定义：view / config（DESIGN §8 权限矩阵）；执行审批只需登录
const VIEW = 'approval:view'
const CONFIG = 'approval:config'

const FLOW_FIELDS = ['code', 'name', 'docType', 'enabled', 'steps']

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const FLOW_SPEC = {
  code: { type: 'code', required: true, max: 64 },
  name: { type: 'string', required: true, max: 64 },
  docType: { type: 'code', required: true, max: 64 },
  enabled: { type: 'bool' },
}

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const FLOW_PATCH_SPEC = {
  name: { type: 'string', max: 64 },
  docType: { type: 'code', max: 64 },
  enabled: { type: 'bool' },
  version: { type: 'int' },
}

/** steps 是对象数组，http/validate 的 DSL 不表达数组 → 交给 svc.normSteps 校验（未知字段同样 400） */
/** @param {Record<string, unknown>} body */
const stepsOfBody = (body) => body.steps

/** @type {import('../http/router.mjs').Handler} */
export async function listFlows(ctx) {
  need(ctx, VIEW)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const docType = ctx.url.searchParams.get('docType') ?? undefined
  const rawEnabled = ctx.url.searchParams.get('enabled')
  const enabled = rawEnabled === null ? undefined : rawEnabled !== 'false'
  sendJson(ctx.res, 200, await svc.listFlows(ctx, page, { docType, enabled }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function getFlow(ctx) {
  need(ctx, VIEW)
  sendJson(ctx.res, 200, await svc.getFlow(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function createFlow(ctx) {
  need(ctx, CONFIG)
  const body = only(await readJson(ctx), FLOW_FIELDS)
  const input = validate(body, FLOW_SPEC)
  const steps = stepsOfBody(body)
  sendJson(
    ctx.res,
    201,
    await svc.createFlow(ctx, {
      .../** @type {any} */ (input),
      steps,
    }),
  )
}

/** @type {import('../http/router.mjs').Handler} */
export async function updateFlow(ctx) {
  need(ctx, CONFIG)
  const body = only(await readJson(ctx), ['name', 'docType', 'enabled', 'steps', 'version'])
  const patch = validate(body, FLOW_PATCH_SPEC, { partial: true })
  if ('steps' in body) patch.steps = body.steps
  sendJson(ctx.res, 200, await svc.updateFlow(ctx, ctx.params.id, patch))
}

/** @type {import('../http/router.mjs').Handler} */
export async function submit(ctx) {
  needUser(ctx)
  const body = only(await readJson(ctx), ['docType', 'docId', 'amount'])
  const input = validate(body, {
    docType: { type: 'code', required: true, max: 64 },
    docId: { type: 'string', required: true, max: 36 },
  })
  const instance = await svc.submit(ctx, {
    docType: String(input.docType),
    docId: String(input.docId),
    amount: /** @type {any} */ (body.amount),
  })
  // 通知是副作用：审批已经落库了，这里失败不能把审批回滚
  await bridge.emitPending(ctx, instance).catch(() => {})
  sendJson(ctx.res, 201, instance)
}

/** @type {import('../http/router.mjs').Handler} */
export async function myTasks(ctx) {
  needUser(ctx)
  sendJson(ctx.res, 200, await svc.myTasks(ctx))
}

/** @type {import('../http/router.mjs').Handler} */
export async function decide(ctx) {
  needUser(ctx)
  const body = only(await readJson(ctx), ['action', 'comment'])
  const input = validate(body, {
    action: { type: 'enum', values: svc.DECIDE_ACTIONS, required: true },
    comment: { type: 'string', max: 500 },
  })
  const result = await svc.decide(ctx, ctx.params.id, {
    action: /** @type {'approve' | 'reject'} */ (input.action),
    comment: input.comment === undefined ? null : String(input.comment),
  })
  const inst = /** @type {any} */ (result).instance ?? result
  // 通过且还有下一级 → 通知下一级；结束 → 通知提交人
  // failed = 审批过了但业务钩子落库失败（如领料库存不足），不能当「已通过」通知
  if (input.action === 'reject' || inst?.status === 'rejected') {
    await bridge.emitFinished(ctx, inst, 'reject').catch(() => {})
  } else if (inst?.status === 'pending') {
    await bridge.emitPending(ctx, inst).catch(() => {})
  } else if (inst?.status === 'failed') {
    await bridge.emitFinished(ctx, inst, 'failed').catch(() => {})
  } else {
    await bridge.emitFinished(ctx, inst, 'approve').catch(() => {})
  }
  sendJson(ctx.res, 200, result)
}

/** @type {import('../http/router.mjs').Handler} */
export async function delegate(ctx) {
  needUser(ctx)
  const body = only(await readJson(ctx), ['toUserId', 'comment'])
  const input = validate(body, { toUserId: { type: 'string', required: true, max: 36 } })
  sendJson(ctx.res, 200, await svc.delegate(ctx, ctx.params.id, String(input.toUserId)))
}

/** @type {import('../http/router.mjs').Handler} */
export async function withdraw(ctx) {
  needUser(ctx)
  sendJson(ctx.res, 200, await svc.withdraw(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function events(ctx) {
  needUser(ctx)
  sendJson(ctx.res, 200, await svc.listEvents(ctx, ctx.params.id))
}
