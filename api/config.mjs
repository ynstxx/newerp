import { need } from '../auth/perm.mjs'
import { only, readJson } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import * as config from '../svc/config.mjs'

/** 配置项的展示元信息（前端据此渲染开关，不用自己抄一份） */
/** @type {Record<string, { type: string, label: string, labelEn: string }>} */
const META = {
  'code.auto': { type: 'bool', label: '自动生成单据编号', labelEn: 'Auto-generate document numbers' },
}

/** @type {import('../http/router.mjs').Handler} */
export async function list(ctx) {
  need(ctx, 'system:config')
  const data = await config.all(ctx)
  sendJson(ctx.res, 200, {
    items: Object.entries(config.DEFAULTS).map(([key]) => ({
      key,
      value: data[key],
      type: META[key]?.type ?? 'string',
      label: META[key]?.label ?? key,
      labelEn: META[key]?.labelEn ?? key,
    })),
  })
}

/** @type {import('../http/router.mjs').Handler} */
export async function put(ctx) {
  need(ctx, 'system:config')
  const key = String(ctx.params.key ?? '')
  if (!(key in config.DEFAULTS)) throw new HttpError(errors.notFound, { reason: `未知配置项 ${key}` })
  const body = only(await readJson(ctx), ['value'])
  const raw = body.value
  const value = typeof raw === 'boolean' ? String(raw) : String(raw ?? '').trim()
  if (value !== 'true' && value !== 'false' && key === 'code.auto') {
    throw new HttpError(errors.badRequest, { fields: { value: 'bool' } })
  }
  await config.set(ctx, key, value)
  sendJson(ctx.res, 200, { key, value })
}
