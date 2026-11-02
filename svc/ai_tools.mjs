import { need } from '../auth/perm.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { centsOf, moneyOf, mulCents } from '../http/money.mjs'
import { normCode } from '../http/validate.mjs'
import * as partyStore from '../store/party.mjs'
import * as party from './party.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * AI 工具注册表（DESIGN §12.1）—— 结构性禁止 AI 直接写库。
 *
 * 工具对象只有两种形状：
 *   read : { name, level:'read',  perm, schema, run(ctx,args) }
 *   write: { name, level:'write', perm, schema, draft(ctx,args) -> {payload, preview} }
 *
 * write 工具**没有 run**（注册时硬校验 + Object.freeze），所以"执行写库"的能力
 * 在对象上不存在；makeDraft 也只返回 payload，不碰业务表。
 * 唯一落库路径是 svc/ai_draft.apply —— 人工审批后调用与人工完全相同的 svc 函数。
 *
 * ponytail: 先注册 party 两个工具。采购切片合并后在这里补 create_purchase_order，
 * 同样只实现 draft()，不要加 run（加了会在注册时报错）。
 */

/** @typedef {{ name: string, description?: string, level: 'read'|'write', perm: string, schema: any, run?: (ctx: any, args: unknown) => Promise<any>, draft?: (ctx: any, args: unknown) => Promise<{ payload: any, preview: any }> }} Tool */

/** @type {Map<string, Readonly<Tool>>} */
const registry = new Map()

/** @param {string} name */
const requireTool = (name) => {
  const tool = registry.get(String(name ?? '').trim())
  if (!tool) throw new HttpError(errors.badRequest, { reason: `未知工具 ${name}` })
  return tool
}

/**
 * @param {Tool} tool
 * @returns {Readonly<Tool>}
 */
export function registerTool(tool) {
  if (!tool || typeof tool !== 'object') throw new Error('registerTool: 需要工具对象')
  if (!tool.name || typeof tool.name !== 'string') throw new Error('registerTool: name 必填')
  if (tool.level !== 'read' && tool.level !== 'write') throw new Error(`registerTool(${tool.name}): level 只能是 read|write`)
  if (!tool.perm) throw new Error(`registerTool(${tool.name}): perm 必填`)
  if (!tool.schema || typeof tool.schema !== 'object') throw new Error(`registerTool(${tool.name}): schema 必填`)

  if (tool.level === 'write') {
    // 最关键的一条：write 工具结构上不能有 run —— 执行通道不存在。
    if ('run' in tool) throw new Error(`registerTool(${tool.name}): write 工具禁止声明 run`)
    if (typeof tool.draft !== 'function') throw new Error(`registerTool(${tool.name}): write 工具必须实现 draft()`)
  } else {
    if ('draft' in tool) throw new Error(`registerTool(${tool.name}): read 工具禁止声明 draft`)
    if (typeof tool.run !== 'function') throw new Error(`registerTool(${tool.name}): read 工具必须实现 run()`)
  }

  if (registry.has(tool.name)) throw new Error(`registerTool: 工具 ${tool.name} 重复注册`)
  const frozen = Object.freeze({ ...tool })
  registry.set(tool.name, frozen)
  return frozen
}

/** @param {string} name */
export const getTool = (name) => registry.get(String(name ?? '').trim()) ?? null

/** 所有工具名（诊断/测试用） */
export const toolNames = () => [...registry.keys()]

/** OpenAI tools 参数：只暴露 name/description/schema，绝不暴露本地函数。 */
export function toolDefs() {
  return [...registry.values()].map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.schema },
  }))
}

/**
 * @param {unknown} v
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function assertObject(v, path = 'args') {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new HttpError(errors.badRequest, { fields: { [path]: 'object' } })
  }
  return /** @type {Record<string, unknown>} */ (v)
}

/**
 * 最小 JSON Schema 校验：object / required / additionalProperties:false / string / integer / boolean / enum。
 * 够工具入参用；不实现 $ref / oneOf，避免把 schema 做成第二套业务校验。
 * @param {any} schema
 * @param {unknown} raw
 */
export function validateArgs(schema, raw) {
  const args = raw === undefined || raw === null ? {} : assertObject(raw)
  const props = schema?.properties ?? {}
  /** @type {Record<string, string>} */
  const bad = {}
  /** @type {Record<string, any>} */
  const out = {}

  if (schema?.additionalProperties === false) {
    const extra = Object.keys(args).filter((k) => !(k in props))
    if (extra.length) throw new HttpError(errors.badRequest, { reason: `工具入参未知字段 ${extra.join(', ')}` })
  }

  for (const [key, spec] of Object.entries(props)) {
    const v = args[key]
    const empty = v === undefined || v === null || v === ''
    if (empty) {
      if ((schema.required ?? []).includes(key)) bad[key] = 'required'
      continue
    }
    if (spec.type === 'string') {
      if (typeof v !== 'string') bad[key] = 'type'
      else if (spec.maxLength && v.length > spec.maxLength) bad[key] = `max:${spec.maxLength}`
      else out[key] = v.trim()
    } else if (spec.type === 'integer') {
      const n = Number(v)
      if (!Number.isInteger(n)) bad[key] = 'type'
      else if (spec.minimum !== undefined && n < spec.minimum) bad[key] = `min:${spec.minimum}`
      else if (spec.maximum !== undefined && n > spec.maximum) bad[key] = `max:${spec.maximum}`
      else out[key] = n
    } else if (spec.type === 'boolean') {
      if (typeof v !== 'boolean') bad[key] = 'type'
      else out[key] = v
    } else if (spec.type === 'array') {
      // 采购单行、BOM 行这类嵌套结构：逐元素用同一套规则校验
      if (!Array.isArray(v)) {
        bad[key] = 'type'
      } else if (spec.minItems && v.length < spec.minItems) {
        bad[key] = `minItems:${spec.minItems}`
      } else if (spec.maxItems && v.length > spec.maxItems) {
        bad[key] = `maxItems:${spec.maxItems}`
      } else {
        out[key] = spec.items ? v.map((el) => validateArgs(spec.items, el)) : v
      }
    } else {
      bad[key] = 'schema'
    }
    if (out[key] !== undefined && spec.enum && !spec.enum.includes(out[key])) {
      bad[key] = `enum:${spec.enum.join('|')}`
    }
  }

  if (Object.keys(bad).length) throw new HttpError(errors.badRequest, { fields: bad })
  return out
}

const str = (/** @type {object} */ extra = {}) => ({ type: 'string', ...extra })

const PARTY_PROPS = {
  code: str({ maxLength: 64, description: '客户/供应商编码，唯一（大小写归一为大写）' }),
  name: str({ maxLength: 64, description: '客户名称' }),
  partyType: { type: 'string', enum: [...party.PARTY_TYPES], description: 'customer=客户 supplier=供应商 both=两者' },
  taxNo: str({ maxLength: 32 }),
  contactName: str({ maxLength: 32 }),
  phone: str({ maxLength: 32 }),
  email: str({ maxLength: 64 }),
  addr: str({ maxLength: 200 }),
  remark: str({ maxLength: 500 }),
}

/** @param {string} v */
const isEmail = (v) => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(v)

const READ_PARTY_SCHEMA = {
  type: 'object',
  properties: {
    keyword: str({ maxLength: 64 }),
    partyType: { type: 'string', enum: [...party.PARTY_TYPES] },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
}

const CREATE_PARTY_SCHEMA = {
  type: 'object',
  properties: PARTY_PROPS,
  required: ['code', 'name', 'partyType'],
  additionalProperties: false,
}


// ── write：采购单（M4 合并后补的；同样只有 draft，没有 run）───────────────
const PO_LINE_SCHEMA = {
  type: 'object',
  properties: {
    itemId: { type: 'string', description: '物料 uuid' },
    qty: { type: 'string', description: '数量，如 "10"' },
    price: { type: 'string', description: '单价，如 "5000.00"' },
  },
  required: ['itemId', 'qty', 'price'],
  additionalProperties: false,
}

const CREATE_PO_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: '采购单号' },
    partyId: { type: 'string', description: '供应商 uuid' },
    projectId: { type: 'string', description: '关联项目 uuid（可空）' },
    note: { type: 'string' },
    lines: { type: 'array', items: PO_LINE_SCHEMA, minItems: 1 },
  },
  required: ['code', 'partyId', 'lines'],
  additionalProperties: false,
}

// ── read：直接调 svc（与人工读同一个函数）──────────────────────────────────
registerTool({
  name: 'read_party_list',
  level: 'read',
  perm: 'party:view',
  description: '查询客户/供应商列表，可按关键字或类型过滤',
  schema: READ_PARTY_SCHEMA,
  async run(ctx, args) {
    const a = validateArgs(READ_PARTY_SCHEMA, args)
    return party.listParties(
      ctx,
      { limit: /** @type {number} */ (a.limit ?? 20), order: 'desc', cursor: null },
      { partyType: /** @type {string | undefined} */ (a.partyType), keyword: /** @type {string | undefined} */ (a.keyword) },
    )
  },
})

// ── write：只有 draft()，永远不会碰业务表 ──────────────────────────────────
registerTool({
  name: 'create_party',
  level: 'write',
  perm: 'party:create',
  description: '起草新建客户/供应商（只生成草稿，必须人工审批后才落库）',
  schema: CREATE_PARTY_SCHEMA,
  /**
   * 只做"读 + 组装 payload"，不写库。apply 时会重新跑一遍（草稿可能躺了几天）。
   * @param {any} ctx
   * @param {unknown} args
   */
  async draft(ctx, args) {
    const a = validateArgs(CREATE_PARTY_SCHEMA, args)
    /** @type {Record<string, string>} */
    const fields = {}
    const code = normCode(a.code)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) throw new HttpError(errors.badRequest, { fields: { code: 'code' } })
    if (a.email && !isEmail(String(a.email))) throw new HttpError(errors.badRequest, { fields: { email: 'email' } })

    const payload = {
      code,
      name: String(a.name),
      partyType: String(a.partyType),
      taxNo: a.taxNo ? String(a.taxNo) : null,
      contactName: a.contactName ? String(a.contactName) : null,
      phone: a.phone ? String(a.phone) : null,
      email: a.email ? String(a.email) : null,
      addr: a.addr ? String(a.addr) : null,
      remark: a.remark ? String(a.remark) : null,
    }

    // 这里只读：编码被占用就直接告诉模型/人，不落任何东西
    if (await partyStore.byCode(ctx, code)) {
      throw new HttpError(errors.conflict, { reason: `编码 ${code} 已存在` })
    }

    /** @type {{ field: string, label: string, before: null, after: string | null }[]} */
    const diff = [
      { field: 'code', label: '编码', before: null, after: payload.code },
      { field: 'name', label: '名称', before: null, after: payload.name },
      { field: 'partyType', label: '类型', before: null, after: payload.partyType },
      { field: 'contactName', label: '联系人', before: null, after: payload.contactName },
      { field: 'phone', label: '电话', before: null, after: payload.phone },
      { field: 'email', label: '邮箱', before: null, after: payload.email },
      { field: 'addr', label: '地址', before: null, after: payload.addr },
      { field: 'remark', label: '备注', before: null, after: payload.remark },
    ]
    for (const f of diff) if (f.after !== null) fields[f.field] = /** @type {string} */ (f.after)

    return {
      payload,
      preview: {
        toolName: 'create_party',
        summary: `新建${payload.partyType === 'customer' ? '客户' : payload.partyType === 'supplier' ? '供应商' : '往来单位'} ${payload.name}（${payload.code}）`,
        changedFields: Object.keys(fields),
        diff,
      },
    }
  },
})

/**
 * 执行 read 工具。write 工具没有 run，这里会直接拒绝 —— 调用方不应该有办法绕过。
 * @param {string} name
 * @param {unknown} args
 * @param {any} ctx
 */
export async function callRead(name, args, ctx) {
  const tool = requireTool(name)
  if (tool.level !== 'read' || typeof tool.run !== 'function') {
    throw new HttpError(errors.badRequest, { reason: `工具 ${name} 不是读工具，不能 run` })
  }
  need(ctx, tool.perm)
  return tool.run(ctx, args)
}

/**
 * 生成草稿（不落库）：write 工具唯一被允许的调用形式。
 * @param {string} name
 * @param {unknown} args
 * @param {any} ctx
 * @returns {Promise<{ payload: any, preview: any }>}
 */
export async function makeDraft(name, args, ctx) {
  const tool = requireTool(name)
  if (tool.level !== 'write' || typeof tool.draft !== 'function') {
    throw new HttpError(errors.badRequest, { reason: `工具 ${name} 不是写工具，不能 draft` })
  }
  need(ctx, tool.perm)
  const out = await tool.draft(ctx, args)
  if (!out || typeof out !== 'object' || out.payload === undefined || out.preview === undefined) {
    throw new Error(`工具 ${name} 的 draft() 必须返回 {payload, preview}`)
  }
  return { payload: out.payload, preview: out.preview }
}

/**
 * 起草采购单。**只有 draft，没有 run** —— 落库只能走 ai_draft.apply() 里的人工审批。
 */
registerTool({
  name: 'create_purchase_order',
  level: 'write',
  perm: 'purchase:create',
  description: '起草采购单（只生成草稿，必须人工审批后才落库）',
  schema: CREATE_PO_SCHEMA,
  /**
   * @param {any} ctx
   * @param {unknown} args
   */
  async draft(ctx, args) {
    const a = validateArgs(CREATE_PO_SCHEMA, args)
    const lines = /** @type {any[]} */ (a.lines).map((l, i) => {
      const itemId = String(l.itemId ?? '').trim()
      if (!UUID.test(itemId)) throw new HttpError(errors.badRequest, { fields: { [`lines.${i}.itemId`]: 'uuid' } })
      const qty = centsOf(String(l.qty), `lines.${i}.qty`)
      const price = centsOf(String(l.price), `lines.${i}.price`)
      if (qty <= 0) throw new HttpError(errors.badRequest, { fields: { [`lines.${i}.qty`]: 'min:>0' } })
      if (price < 0) throw new HttpError(errors.badRequest, { fields: { [`lines.${i}.price`]: 'min:0' } })
      return { itemId, qty: moneyOf(qty), price: moneyOf(price), amount: moneyOf(mulCents(qty, price)) }
    })
    const total = lines.reduce((sum, l) => sum + centsOf(l.amount), 0)
    const payload = {
      code: normCode(a.code),
      partyId: String(a.partyId).trim(),
      projectId: a.projectId ? String(a.projectId).trim() : null,
      note: a.note ? String(a.note) : null,
      // 行金额由 createPo 自己用分算法重算，payload 里不塞 amount
      // （apply 时会重跑一遍 draft()，多一个字段就会被 schema 判未知字段）
      lines: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, price: l.price })),
    }
    return {
      payload,
      preview: {
        单号: payload.code,
        供应商: payload.partyId,
        行数: lines.length,
        合计: moneyOf(total),
        明细: lines.map((l) => `${l.itemId} × ${l.qty} @ ${l.price} = ${l.amount}`),
      },
    }
  },
})

