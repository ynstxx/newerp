import { createHash, randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/notify.mjs'
import * as inapp from './notify_inapp.mjs'
import * as emailHttp from './notify_email_http.mjs'
import * as webhook from './notify_webhook.mjs'
import { ChannelError } from './notify_http.mjs'
import { openConfig, publicConfig, sealConfig } from './notify_crypto.mjs'

/**
 * 通知中心（DESIGN §10）。这里是唯一做业务判断的地方：
 *   事件 → 收件人解析 → 渠道选择 → 模板渲染 → outbox（幂等入队）
 * worker 只负责把 outbox 里的行搬出去（svc/notify_worker.mjs）。
 */

/** 渠道清单，顺序即 emit 时的建行顺序 */
export const CHANNELS = /** @type {const} */ (['inapp', 'email', 'dingtalk', 'wecom'])

/** v1 事件集（DESIGN §10.5）—— 仅用于文档/校验提示，模板 code 就是事件名 */
export const EVENTS = [
  'approval.pending',
  'approval.approved',
  'approval.rejected',
  'ticket.assigned',
  'ticket.sla_warning',
  'ar.overdue',
  'stock.low',
  'ai_draft.pending',
  'tenant.quota_warning',
]

/** 退避表：1m / 5m / 15m / 1h / 6h（第 5 次失败后不再重试） */
export const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000]
export const MAX_ATTEMPTS = 5

/** 群机器人是群级投递，outbox 的 to_addr 只放群标识 */
const GROUP = 'group'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/
const LANG = /^[a-z]{2}(-[A-Za-z]{2})?$/

/** @param {string} id */
function assertId(id) {
  if (!UUID.test(id)) throw new HttpError(errors.notFound)
  return id
}

/** @param {unknown} v @param {string} name */
function assertCode(v, name) {
  if (typeof v !== 'string' || !CODE.test(v)) {
    throw new HttpError(errors.badRequest, { fields: { [name]: 'code' } })
  }
  return v
}

/** @param {number} attempts 已经失败的次数（1 = 第一次失败） */
export const retryDelayMs = (attempts) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]

/**
 * 幂等键：sha256(tenant|channel|template|docId|step|to_addr)。
 *
 * DESIGN §10.4 写的是前 5 元组，这里**多带一个收件人**：少了它，同一张单据的两个收件人
 * 会撞同一个键，第二个直接被去重掉 —— 通知只发给一个人比重复发一遍严重得多。
 * `step` 留给审批多轮（同一单据同一模板的不同轮次）。
 * @param {{ tenantId: string, channel: string, templateCode: string, docId: string, step: string, toAddr: string }} p
 */
export function dedupeKey(p) {
  return createHash('sha256')
    .update([p.tenantId, p.channel, p.templateCode, p.docId, p.step, p.toAddr].join('|'))
    .digest('hex')
}

/**
 * 极简占位符：`{{doc_no}}` / `{{amount}}`。不认识的键原样保留 —— 界面上看得见才会有人修。
 * @param {string} text
 * @param {Record<string, unknown>} vars
 */
export function render(text, vars) {
  return String(text ?? '').replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (m, k) => {
    const v = vars[k]
    return v === undefined || v === null ? m : String(v)
  })
}

// —— 收件人解析 ——

/**
 * `{ userId }` / `{ role }` / `{ field: 'project.pm_user_id' }` → 去重后的有效用户
 * @param {any} ctx
 * @param {unknown[]} recipients
 * @param {string} docId
 * @returns {Promise<{ userId: string, email: string | null }[]>}
 */
export async function resolveRecipients(ctx, recipients, docId) {
  if (!Array.isArray(recipients)) throw new HttpError(errors.badRequest, { fields: { recipients: 'array' } })

  /** @type {Map<string, { userId: string, email: string | null }>} */
  const out = new Map()

  for (const raw of recipients) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new HttpError(errors.badRequest, { fields: { recipients: 'object' } })
    }
    const r = /** @type {Record<string, unknown>} */ (raw)
    const keys = Object.keys(r)
    if (keys.length !== 1) {
      throw new HttpError(errors.badRequest, { reason: `收件人只能有 userId/role/field 三者之一：${keys.join(',')}` })
    }

    /** @type {{ id: string, email: string | null }[]} */
    let users = []
    if (typeof r.userId === 'string') {
      const u = await store.userById(ctx, assertId(r.userId))
      // 跨租户的 user id 一律丢弃：auth_user 是全局表，复合外键保护不到
      if (u && (await store.isMember(ctx, u.id))) users = [u]
    } else if (typeof r.role === 'string') {
      users = await store.usersByRole(ctx, assertCode(r.role, 'recipients.role'))
    } else if (typeof r.field === 'string') {
      const read = store.FIELD_READERS[r.field]
      if (!read) {
        throw new HttpError(errors.badRequest, {
          reason: `不支持的收件人字段 ${r.field}（可用：${Object.keys(store.FIELD_READERS).join(', ')}）`,
        })
      }
      if (!docId || !UUID.test(docId)) {
        throw new HttpError(errors.badRequest, { reason: `field 收件人需要合法 docId，收到 ${docId || '(空)'}` })
      }
      const row = await read(ctx, docId)
      if (row?.v) {
        const u = await store.userById(ctx, row.v)
        if (u) users = [u]
      }
    } else {
      throw new HttpError(errors.badRequest, { reason: '收件人需要 userId / role / field 之一' })
    }

    // 非本租户有效成员一律丢弃：宁可少发，也不往别租户的人发
    for (const u of users) out.set(u.id, { userId: u.id, email: u.email ?? null })
  }
  return [...out.values()]
}

/**
 * 候选渠道 = 站内信（永远算候选，缺模板就落 failed 暴露出来）
 *          ∪ 已启用且配过的渠道
 *          ∪ 该事件已配模板的渠道
 * @param {any} ctx @param {string} code
 */
async function candidateChannels(ctx, code) {
  /** @type {Set<string>} */
  const set = new Set(['inapp'])
  for (const c of await store.listChannels(ctx)) if (c.enabled) set.add(c.type)
  for (const r of await store.templateChannels(ctx, code)) set.add(r.channel)
  return CHANNELS.filter((c) => set.has(c))
}

// —— emit ——

/**
 * @param {any} ctx
 * @param {string} event 事件名 = 模板 code（如 'approval.pending'）
 * @param {{ docType?: string, docId?: string, recipients?: unknown[], vars?: Record<string, unknown>, step?: string, lang?: string, template?: string }} [opts]
 */
export async function emit(ctx, event, opts = {}) {
  const templateCode = assertCode(opts.template ?? event, 'event')
  const docId = opts.docId ?? ''
  const step = opts.step ?? ''
  const lang = LANG.test(String(opts.lang ?? 'zh')) ? String(opts.lang ?? 'zh') : 'zh'
  const vars = { ...(opts.vars ?? {}) }

  const users = await resolveRecipients(ctx, opts.recipients ?? [], docId)
  const channels = await candidateChannels(ctx, templateCode)
  const now = new Date()

  /** @type {{ id: string, channel: string, toAddr: string, templateCode: string, vars: unknown, status: string, error: string | null, dedupeKey: string, now: Date }[]} */
  const rows = []

  for (const channel of channels) {
    const groupLevel = channel === 'dingtalk' || channel === 'wecom'
    /** @type {{ toAddr: string }[]} */
    const targets = groupLevel
      ? [{ toAddr: GROUP }]
      : users.map((u) => ({ toAddr: channel === 'email' ? String(u.email ?? '') : u.userId }))

    if (!targets.length) {
      if (channel === 'inapp') rows.push(rowOf(channel, 'unknown', '收件人解析为空（0 个有效成员）'))
      continue
    }

    const tpl = await store.templateFor(ctx, templateCode, channel, lang)
    for (const t of targets) {
      if (!t.toAddr) continue
      if (!tpl) {
        rows.push(rowOf(channel, t.toAddr, `模板缺失：${templateCode} / ${channel} / ${lang}`))
        continue
      }
      const all = { ...vars, docType: opts.docType ?? '', docId, event: templateCode }
      rows.push(rowOf(channel, t.toAddr, null, { ...all, _subject: render(String(tpl.subject ?? ''), all), _body: render(String(tpl.body ?? ''), all), _link: vars.link ?? null }))
    }
  }

  /**
   * @param {string} channel
   * @param {string} toAddr
   * @param {string | null} error 非空 = 直接落 failed（模板缺失等），不静默吞掉
   * @param {Record<string, unknown>} [varsOut]
   */
  function rowOf(channel, toAddr, error, varsOut) {
    return {
      id: randomUUID(),
      channel,
      toAddr: toAddr.slice(0, 64),
      templateCode,
      vars: varsOut ?? vars,
      status: error ? 'failed' : 'pending',
      error,
      dedupeKey: dedupeKey({ tenantId: String(ctx.tenantId), channel, templateCode, docId, step, toAddr }),
      now,
    }
  }

  const { queued, deduped } = await insertRows(ctx, rows)
  const failed = rows.filter((r) => r.status === 'failed').length

  await withTx(ctx, (tx) =>
    audit.insert(tx, {
      id: randomUUID(),
      module: 'notify',
      action: 'emit',
      whoId: ctx.userId ?? null,
      refType: opts.docType ?? null,
      refId: docId || null,
      before: null,
      after: { event: templateCode, recipients: users.length, channels, queued, deduped, failed },
      traceId: ctx.requestId ?? '',
      at: now,
    }),
  )

  return { event: templateCode, recipients: users.length, channels, queued, deduped, failed }
}

/**
 * 批量入队。撞唯一键（= 已入队过）当成 dedupe，不当 500。
 * 先试一把整批同事务（常见路径一次往返）；唯一键冲突会让 PG 把整个事务作废，
 * 所以冲突后退化成「逐行独立事务」，两库语义一致。
 * @param {any} ctx
 * @param {any[]} rows
 */
async function insertRows(ctx, rows) {
  if (!rows.length) return { queued: 0, deduped: 0 }
  try {
    await withTx(ctx, async (tx) => {
      for (const r of rows) await store.insertOutbox(tx, r)
    })
    return { queued: rows.length, deduped: 0 }
  } catch (err) {
    if (!store.isUniqueViolation(err)) throw err
  }

  let queued = 0
  let deduped = 0
  for (const r of rows) {
    try {
      await withTx(ctx, (tx) => store.insertOutbox(tx, r))
      queued++
    } catch (err) {
      if (!store.isUniqueViolation(err)) throw err
      deduped++
    }
  }
  return { queued, deduped }
}

// —— 投递（worker 调） ——

/**
 * @param {any} ctx 已带 tenantId
 * @param {{ channel: string, toAddr: string, templateCode?: string, subject?: string, body?: string, link?: string | null }} job
 */
export async function deliver(ctx, job) {
  if (job.channel === 'inapp') return inapp.send(ctx, job)

  const cfgRow = await store.channelByType(ctx, job.channel)
  if (!cfgRow) throw new ChannelError(`渠道 ${job.channel} 未配置`)
  if (!cfgRow.enabled) throw new ChannelError(`渠道 ${job.channel} 已停用`)
  const cfg = openConfig(/** @type {any} */ (store.parseJson(cfgRow.config)))

  if (job.channel === 'email') return emailHttp.send(job, cfg)
  if (job.channel === 'dingtalk') return webhook.sendDingtalk(job, cfg)
  if (job.channel === 'wecom') return webhook.sendWecom(job, cfg)
  throw new ChannelError(`未知渠道 ${job.channel}`)
}

// —— 映射 ——

/** @param {any} r */
export const channelToApi = (r) => ({
  id: r.id,
  type: r.type,
  enabled: Boolean(r.enabled),
  config: publicConfig(/** @type {any} */ (store.parseJson(r.config))),
  version: r.version,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const templateToApi = (r) => ({
  id: r.id,
  code: r.code,
  channel: r.channel,
  lang: r.lang,
  subject: r.subject,
  body: r.body,
  version: r.version,
  updatedAt: r.updated_at,
})

/** @param {any} r */
export const inboxToApi = (r) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  link: r.link,
  readAt: r.read_at,
  createdAt: r.created_at,
})

// —— 渠道配置 ——

/** @param {any} ctx */
export async function listChannels(ctx) {
  return { items: (await store.listChannels(ctx)).map(channelToApi) }
}

/**
 * @param {any} ctx
 * @param {{ type: string, enabled?: boolean, config?: Record<string, unknown> }} input
 */
export async function createChannel(ctx, input) {
  if (!CHANNELS.includes(/** @type {any} */ (input.type))) {
    throw new HttpError(errors.badRequest, { fields: { type: `enum:${CHANNELS.join('|')}` } })
  }
  if (await store.channelByType(ctx, input.type)) {
    throw new HttpError(errors.conflict, { reason: `渠道 ${input.type} 已存在，请用 PUT 修改` })
  }
  const now = new Date()
  const id = randomUUID()
  await withTx(ctx, async (tx) => {
    await store.insertChannel(tx, {
      id,
      type: input.type,
      enabled: input.enabled ?? true,
      config: sealConfig(input.config ?? {}),
      now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'notify',
      action: 'channel.create',
      whoId: ctx.userId ?? null,
      refType: 'notify_channel',
      refId: id,
      before: null,
      after: { type: input.type, enabled: input.enabled ?? true, config: publicConfig(input.config) },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return channelToApi(/** @type {any} */ (await store.channelById(ctx, id)))
}

/**
 * 局部更新：config 与原配置**合并**（密钥永远不用回传），值为 null 表示删掉该键。
 * @param {any} ctx
 * @param {string} id
 * @param {{ enabled?: boolean, config?: Record<string, unknown>, version?: number }} patch
 */
export async function updateChannel(ctx, id, patch) {
  const cur = await store.channelById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `配置已被他人修改（当前 version ${cur.version}）` })
  }

  const merged = { .../** @type {any} */ (store.parseJson(cur.config)) }
  for (const [k, v] of Object.entries(patch.config ?? {})) {
    if (v === null || v === undefined) delete merged[k]
    else merged[k] = v
  }
  const sealed = sealConfig(merged)
  const enabled = patch.enabled === undefined ? Boolean(cur.enabled) : patch.enabled
  const now = new Date()

  await withTx(ctx, async (tx) => {
    const n = await store.updateChannel(tx, { id, enabled, config: sealed, expectedVersion: cur.version, now })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'notify',
      action: 'channel.update',
      whoId: ctx.userId ?? null,
      refType: 'notify_channel',
      refId: id,
      before: { enabled: Boolean(cur.enabled), config: publicConfig(/** @type {any} */ (store.parseJson(cur.config))) },
      after: { enabled, config: publicConfig(sealed) },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return channelToApi(/** @type {any} */ (await store.channelById(ctx, id)))
}

// —— 模板 ——

/** @param {any} ctx */
export async function listTemplates(ctx) {
  return { items: (await store.listTemplates(ctx)).map(templateToApi) }
}

/**
 * @param {any} ctx
 * @param {{ code: string, channel: string, lang?: string, subject?: string, body: string }} input
 */
export async function createTemplate(ctx, input) {
  const code = assertCode(input.code, 'code')
  if (!CHANNELS.includes(/** @type {any} */ (input.channel))) {
    throw new HttpError(errors.badRequest, { fields: { channel: `enum:${CHANNELS.join('|')}` } })
  }
  const lang = input.lang ?? 'zh'
  if (!LANG.test(lang)) throw new HttpError(errors.badRequest, { fields: { lang: 'lang' } })

  const now = new Date()
  const id = randomUUID()
  try {
    await withTx(ctx, async (tx) => {
      await store.insertTemplate(tx, {
        id,
        code,
        channel: input.channel,
        lang,
        subject: input.subject ?? null,
        body: input.body,
        now,
      })
      await audit.insert(tx, {
        id: randomUUID(),
        module: 'notify',
        action: 'template.create',
        whoId: ctx.userId ?? null,
        refType: 'notify_template',
        refId: id,
        before: null,
        after: { code, channel: input.channel, lang },
        traceId: ctx.requestId ?? '',
        at: now,
      })
    })
  } catch (err) {
    if (store.isUniqueViolation(err)) {
      throw new HttpError(errors.conflict, { reason: `${code}/${input.channel}/${lang} 模板已存在` })
    }
    throw err
  }
  return templateToApi(/** @type {any} */ (await store.templateById(ctx, id)))
}

/**
 * code/channel 不可改（改了等于换模板，会打乱 emit 的幂等键），只改语言/内容。
 * @param {any} ctx
 * @param {string} id
 * @param {{ lang?: string, subject?: string | null, body?: string, version?: number }} patch
 */
export async function updateTemplate(ctx, id, patch) {
  const cur = await store.templateById(ctx, assertId(id))
  if (!cur) throw new HttpError(errors.notFound)
  if (patch.version !== undefined && patch.version !== cur.version) {
    throw new HttpError(errors.conflict, { reason: `模板已被他人修改（当前 version ${cur.version}）` })
  }
  const lang = patch.lang ?? cur.lang
  if (!LANG.test(lang)) throw new HttpError(errors.badRequest, { fields: { lang: 'lang' } })

  const now = new Date()
  await withTx(ctx, async (tx) => {
    const n = await store.updateTemplate(tx, {
      id,
      lang,
      subject: patch.subject === undefined ? cur.subject : patch.subject,
      body: patch.body === undefined ? cur.body : patch.body,
      expectedVersion: cur.version,
      now,
    })
    if (!n) throw new HttpError(errors.conflict, { reason: '并发修改，请重试' })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'notify',
      action: 'template.update',
      whoId: ctx.userId ?? null,
      refType: 'notify_template',
      refId: id,
      before: { lang: cur.lang, subject: cur.subject, body: cur.body },
      after: { lang, subject: patch.subject ?? cur.subject, body: patch.body ?? cur.body },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
  return templateToApi(/** @type {any} */ (await store.templateById(ctx, id)))
}

// —— 测试消息 ——

/**
 * 给自己发一条测试消息（排障用）。走真实渠道，因此能验证 key/签名/模板是否配对。
 * 失败不抛 500：把对方返回的错误原样带回去，比一个「服务器繁忙」有用得多。
 * @param {any} ctx
 * @param {{ channel: string }} input
 */
export async function sendTest(ctx, input) {
  const channel = input.channel
  if (!CHANNELS.includes(/** @type {any} */ (channel))) {
    throw new HttpError(errors.badRequest, { fields: { channel: `enum:${CHANNELS.join('|')}` } })
  }
  const me = await store.userById(ctx, String(ctx.userId))
  if (!me) throw new HttpError(errors.unauthorized)

  const target = channel === 'email' ? String(me.email ?? '') : channel === 'inapp' ? String(me.id) : GROUP
  const job = {
    channel,
    toAddr: target,
    templateCode: 'notify.test',
    subject: `【${ctx.tenant?.name ?? 'NewERP'}】通知测试`,
    body: `这是一条测试消息，渠道 ${channel}，时间 ${new Date().toISOString()}。`,
    link: null,
  }

  /** @type {{ ok: boolean, channel: string, error?: string }} */
  const result = { ok: true, channel }
  try {
    await deliver(ctx, job)
  } catch (err) {
    result.ok = false
    result.error = err instanceof ChannelError ? err.message : String(/** @type {Error} */ (err)?.message ?? err)
  }

  await withTx(ctx, (tx) =>
    audit.insert(tx, {
      id: randomUUID(),
      module: 'notify',
      action: 'channel.test',
      whoId: ctx.userId ?? null,
      refType: 'notify_channel',
      refId: null,
      before: null,
      after: { channel, ok: result.ok, error: result.error ?? null },
      traceId: ctx.requestId ?? '',
      at: new Date(),
    }),
  )
  return result
}
