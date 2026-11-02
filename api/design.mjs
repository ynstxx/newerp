import { need, PERM } from '../auth/perm.mjs'
import { readJson, only } from '../http/body.mjs'
import { sendJson } from '../http/context.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { parsePage } from '../http/page.mjs'
import { validate } from '../http/validate.mjs'
import * as svc from '../svc/design.mjs'

const CREATE_FIELDS = ['projectId', 'title', 'content', 'bomLines']
const PATCH_FIELDS = ['version', 'content', 'bomLines']
const ADVANCE_FIELDS = ['to']
const LINE_FIELDS = ['lineNo', 'itemName', 'spec', 'uom', 'qty', 'unitCost', 'note']
const MAX_LINES = 200

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const SPEC = {
  projectId: { type: 'string', required: true, max: 64 },
  title: { type: 'string', required: true, max: 64 },
  version: { type: 'int' },
  content: { type: 'string', max: 2000 },
}

/** @type {Record<string, import('../http/validate.mjs').Field>} */
const ADVANCE_SPEC = { to: { type: 'enum', values: svc.DESIGN_STATUSES, required: true } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 查询串里的 projectId 过滤：非法值 400，别让它变成 PG 的类型错误 */
function uuidFilter(/** @type {string | null} */ raw) {
  if (!raw) return undefined
  if (!UUID.test(raw)) throw new HttpError(errors.badRequest, { reason: 'projectId 不是 uuid' })
  return raw
}

/** @param {unknown} v @param {string} path @param {number} max */
function reqText(v, path, max) {
  if (typeof v !== 'string') throw new HttpError(errors.badRequest, { fields: { [path]: 'type' } })
  const s = v.trim()
  if (!s) throw new HttpError(errors.badRequest, { fields: { [path]: 'required' } })
  if (s.length > max) throw new HttpError(errors.badRequest, { fields: { [path]: `max:${max}` } })
  return s
}

/** @param {unknown} v @param {string} path @param {number} max */
function optText(v, path, max) {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new HttpError(errors.badRequest, { fields: { [path]: 'type' } })
  const s = v.trim()
  if (!s) return null
  if (s.length > max) throw new HttpError(errors.badRequest, { fields: { [path]: `max:${max}` } })
  return s
}

/** @param {unknown} v @param {string} path */
function money(v, path) {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new HttpError(errors.badRequest, { fields: { [path]: 'money' } })
  }
  return n
}

/**
 * BOM 行是嵌套结构，validate() 只认平铺字段，这里自己挡：
 * 未知行内字段、重复 lineNo、非数字金额一律 400。
 * @param {unknown} raw
 */
function parseBomLines(raw) {
  if (!Array.isArray(raw)) throw new HttpError(errors.badRequest, { fields: { bomLines: 'array' } })
  if (raw.length > MAX_LINES) throw new HttpError(errors.badRequest, { fields: { bomLines: `max:${MAX_LINES}` } })

  /** @type {Set<number>} */
  const seen = new Set()
  return raw.map((item, i) => {
    const at = `bomLines[${i}]`
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new HttpError(errors.badRequest, { fields: { [at]: 'object' } })
    }
    const line = /** @type {Record<string, unknown>} */ (item)
    const extra = Object.keys(line).filter((k) => !LINE_FIELDS.includes(k))
    if (extra.length) {
      throw new HttpError(errors.badRequest, { reason: `未知字段 ${at}.${extra.join(', ')}` })
    }

    const lineNo = Number(line.lineNo)
    if (!Number.isInteger(lineNo) || lineNo < 1) {
      throw new HttpError(errors.badRequest, { fields: { [`${at}.lineNo`]: 'int:>=1' } })
    }
    if (seen.has(lineNo)) throw new HttpError(errors.badRequest, { fields: { [`${at}.lineNo`]: 'duplicate' } })
    seen.add(lineNo)

    return {
      lineNo,
      itemName: reqText(line.itemName, `${at}.itemName`, 64),
      spec: optText(line.spec, `${at}.spec`, 64),
      uom: optText(line.uom, `${at}.uom`, 64),
      qty: money(line.qty, `${at}.qty`),
      unitCost: money(line.unitCost, `${at}.unitCost`),
      note: optText(line.note, `${at}.note`, 500),
    }
  })
}

/** @type {import('../http/router.mjs').Handler} */
export async function list(ctx) {
  need(ctx, PERM.designView)
  const page = parsePage(ctx, { defaultLimit: 20, maxLimit: 100 })
  const filters = { projectId: uuidFilter(ctx.url.searchParams.get('projectId')) }
  sendJson(ctx.res, 200, await svc.listDesignDocs(ctx, page, filters))
}

/** @type {import('../http/router.mjs').Handler} */
export async function get(ctx) {
  need(ctx, PERM.designView)
  sendJson(ctx.res, 200, await svc.getDesignDoc(ctx, ctx.params.id))
}

/** @type {import('../http/router.mjs').Handler} */
export async function create(ctx) {
  need(ctx, PERM.designCreate)
  const body = only(await readJson(ctx), CREATE_FIELDS)
  const input = validate(body, SPEC)
  const bomLines = parseBomLines(body.bomLines)
  sendJson(ctx.res, 201, await svc.createDesignDoc(ctx, { .../** @type {any} */ (input), bomLines }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function update(ctx) {
  need(ctx, PERM.designUpdate)
  const body = only(await readJson(ctx), PATCH_FIELDS)
  const patch = validate(body, SPEC, { partial: true })
  const bomLines = body.bomLines === undefined ? undefined : parseBomLines(body.bomLines)
  sendJson(ctx.res, 200, await svc.updateDesignDoc(ctx, ctx.params.id, { ...patch, bomLines }))
}

/** @type {import('../http/router.mjs').Handler} */
export async function advance(ctx) {
  need(ctx, PERM.designUpdate)
  const body = only(await readJson(ctx), ADVANCE_FIELDS)
  const { to } = validate(body, ADVANCE_SPEC)
  sendJson(ctx.res, 200, await svc.advanceDesignDoc(ctx, ctx.params.id, String(to)))
}
