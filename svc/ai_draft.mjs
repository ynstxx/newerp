import { randomUUID } from 'node:crypto'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import { trimPage } from '../http/page.mjs'
import * as approvalStore from '../store/approval.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/ai.mjs'
import * as approval from './approval.mjs'
import * as hooks from './approval_hooks.mjs'
import * as client from './ai_client.mjs'
import * as settings from './ai_settings.mjs'
import * as tools from './ai_tools.mjs'
import * as party from './party.mjs'
import * as purchase from './purchase.mjs'
import { allowedNext, assertTransition } from './transition.mjs'

/**
 * AI 草稿流水线（DESIGN §12.2）。
 *
 *   chat    : 模型 → tool_call → 工具 draft() → ai_draft(pending) → 复用审批引擎
 *   approve : 人审通过（调用 §9 审批引擎，doc_type='ai_draft'）
 *   reject  : 人审驳回（原因必填）
 *   apply   : 开事务 → 重新校验 payload → 调**与人工完全相同**的 svc 函数 → 回写 applied_ref
 *
 * 幂等：apply 先对 ai_draft 行 FOR UPDATE；同一 draft 并发/重复 apply 只会落一单，
 * 第二个请求看到 status='applied' 直接返回原 applied_ref。
 */

export const DRAFT_STATUSES = /** @type {const} */ ([
  'draft',
  'pending',
  'approved',
  'applied',
  'rejected',
  'failed',
])

export const DRAFT_TRANSITIONS = /** @type {const} */ ({
  draft: ['pending', 'rejected'],
  pending: ['approved', 'rejected'],
  approved: ['applied', 'failed'],
  failed: ['applied'],
  applied: [],
  rejected: [],
})

const DOC_TYPE = 'AI_DRAFT'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 非 uuid 的 id 直接当不存在 —— 别让 PG 的类型错误冒成 500 @param {string} id */
function assertId(id) {
  if (!UUID.test(String(id))) throw new HttpError(errors.notFound)
  return String(id)
}

/** @param {unknown} v */
const jsonOf = (v) => (typeof v === 'string' ? JSON.parse(v) : v)

/** @param {any} r */
export const toApi = (r) => ({
  id: r.id,
  toolName: r.tool_name,
  payload: jsonOf(r.payload),
  preview: jsonOf(r.preview),
  status: r.status,
  submitterId: r.submitter_id,
  appliedRefType: r.applied_ref_type,
  appliedRefId: r.applied_ref_id,
  error: r.error,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  allowed: allowedNext(DRAFT_TRANSITIONS, r.status),
})

/**
 * 审批结果回写到草稿：与 approval decide 同一个事务，审批与草稿状态同生共死。
 * 只有 pending 会被更新；已落库的草稿绝不被审批回调覆盖。
 */
hooks.register(DOC_TYPE, {
  async onApproved(tx, _docType, docId) {
    const n = await store.draftFinishReview(tx, docId, 'approved', new Date())
    if (n) {
      await audit.insert(tx, {
        id: randomUUID(),
        module: 'ai',
        action: 'draft_approved',
        whoId: tx.userId ?? null,
        refType: 'ai_draft',
        refId: docId,
        before: { status: 'pending' },
        after: { status: 'approved' },
        traceId: tx.requestId ?? '',
        at: new Date(),
      })
    }
  },
  async onRejected(tx, _docType, docId) {
    const n = await store.draftFinishReview(tx, docId, 'rejected', new Date())
    if (n) {
      await audit.insert(tx, {
        id: randomUUID(),
        module: 'ai',
        action: 'draft_rejected',
        whoId: tx.userId ?? null,
        refType: 'ai_draft',
        refId: docId,
        before: { status: 'pending' },
        after: { status: 'rejected' },
        traceId: tx.requestId ?? '',
        at: new Date(),
      })
    }
  },
})

/** @param {any} ctx @param {string} id */
async function requireDraft(ctx, id) {
  const row = await store.draftById(ctx, assertId(id))
  if (!row) throw new HttpError(errors.notFound)
  return row
}

/**
 * 对话消息校验。只接受 system/user/assistant，工具消息由服务端内部追加。
 * @param {unknown} messages
 */
function normMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(errors.badRequest, { fields: { messages: 'non_empty_array' } })
  }
  if (messages.length > 50) throw new HttpError(errors.badRequest, { fields: { messages: 'max:50' } })
  return messages.map((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      throw new HttpError(errors.badRequest, { fields: { [`messages.${i}`]: 'object' } })
    }
    const msg = /** @type {Record<string, unknown>} */ (m)
    const extra = Object.keys(msg).filter((k) => k !== 'role' && k !== 'content')
    if (extra.length) throw new HttpError(errors.badRequest, { reason: `messages.${i} 未知字段 ${extra.join(', ')}` })
    const role = String(msg.role ?? '')
    if (!['system', 'user', 'assistant'].includes(role)) {
      throw new HttpError(errors.badRequest, { fields: { [`messages.${i}.role`]: 'enum:system|user|assistant' } })
    }
    const content = typeof msg.content === 'string' ? msg.content : ''
    if (!content.trim()) throw new HttpError(errors.badRequest, { fields: { [`messages.${i}.content`]: 'required' } })
    if (content.length > 8000) throw new HttpError(errors.badRequest, { fields: { [`messages.${i}.content`]: 'max:8000' } })
    return { role, content }
  })
}

/**
 * 草稿 + 审批实例在同一个事务里创建：没有可用审批流程时整体回滚，
 * 不会留下"有草稿、无审批"的半截数据。
 * @param {any} ctx
 * @param {{ toolName: string, payload: unknown, preview: unknown }} d
 */
async function createDraftAndSubmit(ctx, d) {
  const id = randomUUID()
  const now = new Date()
  return withTx(ctx, async (tx) => {
    await store.draftInsert(tx, {
      id,
      toolName: d.toolName,
      payload: d.payload,
      preview: d.preview,
      status: 'pending',
      submitterId: /** @type {string} */ (ctx.userId),
      now,
    })
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'ai',
      action: 'create_draft',
      whoId: ctx.userId ?? null,
      refType: 'ai_draft',
      refId: id,
      before: null,
      after: { toolName: d.toolName, preview: d.preview },
      traceId: ctx.requestId ?? '',
      at: now,
    })
    const instance = await approval.submit(tx, { docType: 'ai_draft', docId: id, amount: '0' })
    const row = await store.draftById(tx, id)
    return { draft: toApi(row), instance }
  })
}

/**
 * 一条用户消息 → 模型 → 工具草稿。
 * 读工具会被执行并把结果回喂模型（最多 4 轮），写工具只生成草稿。
 * @param {any} ctx
 * @param {unknown} messages
 */
export async function chat(ctx, messages) {
  const { row, apiKey } = await settings.assertReady(ctx)
  /** @type {any[]} */
  let msgs = normMessages(messages)
  const defs = tools.toolDefs()

  for (let round = 0; round < 4; round++) {
    const out = await client.complete(ctx, { settings: row, apiKey, messages: msgs, tools: defs })
    const calls = out.toolCalls
    const traceBase = {
      model: out.model,
      usage: out.usage,
      durationMs: out.durationMs,
      toolCalls: calls,
    }

    const writeCall = calls.find((c) => tools.getTool(c?.function?.name)?.level === 'write')
    if (writeCall) {
      const name = String(writeCall.function.name)
      let draftId = null
      try {
        const args = client.parseToolArgs(writeCall.function.arguments)
        const made = await tools.makeDraft(name, args, ctx)
        const created = await createDraftAndSubmit(ctx, { toolName: name, ...made })
        draftId = created.draft.id
        await client.recordTrace(ctx, { ...traceBase, draftId })
        return {
          draft: created.draft,
          diff: created.draft.preview?.diff ?? [],
          approval: created.instance,
          reply: out.message.content ?? null,
        }
      } catch (err) {
        // 即使草稿没建出来，这次模型调用也已经发生（花了 token），必须留痕
        await client.recordTrace(ctx, { ...traceBase, draftId: null })
        throw err
      }
    }

    // 没有写工具：要么是读工具（执行后回喂），要么只是普通回答
    await client.recordTrace(ctx, { ...traceBase, draftId: null })

    if (!calls.length) {
      return { draft: null, diff: [], approval: null, reply: out.message.content ?? '' }
    }

    msgs = [
      ...msgs,
      { role: 'assistant', content: out.message.content ?? null, tool_calls: calls },
    ]
    for (const c of calls) {
      const name = String(c?.function?.name ?? '')
      let payload
      try {
        const args = client.parseToolArgs(c.function?.arguments)
        payload = await tools.callRead(name, args, ctx)
      } catch (err) {
        const details = err instanceof HttpError ? /** @type {any} */ (err.details) : null
        payload = { error: err instanceof HttpError ? (details?.reason ?? err.zh) : /** @type {Error} */ (err).message }
      }
      msgs.push({ role: 'tool', tool_call_id: c.id ?? name, content: JSON.stringify(payload) })
    }
  }

  throw new HttpError(errors.conflict, { reason: '模型连续 4 轮未给出可审批的草稿' })
}

/**
 * 人审通过：找到该草稿的审批任务，交给 §9 审批引擎处理（不另造一套审批）。
 * @param {any} ctx @param {string} draftId
 */
export async function approve(ctx, draftId) {
  const draft = await requireDraft(ctx, draftId)
  // 先 404 再 503：跨租户一律 404，离线降级不能把存在性泄露成 503
  await settings.assertReady(ctx)
  if (draft.status === 'approved' || draft.status === 'applied') return toApi(draft)
  assertTransition('ai_draft', DRAFT_TRANSITIONS, draft.status, 'approved')

  const inst = await approvalStore.pendingInstanceByDoc(ctx, DOC_TYPE, draft.id)
  if (!inst) throw new HttpError(errors.conflict, { reason: '草稿没有在途审批' })
  const tasks = await approvalStore.pendingTasksByInstance(ctx, inst.id)
  if (!tasks.length) throw new HttpError(errors.conflict, { reason: '没有待处理的审批任务' })

  await approval.decide(ctx, tasks[0].id, { action: 'approve', comment: null })
  return toApi(await store.draftById(ctx, draft.id))
}

/**
 * 人审驳回，reason 必填（写进审批事件，可追溯）。
 * @param {any} ctx @param {string} draftId @param {string} reason
 */
export async function reject(ctx, draftId, reason) {
  const draft = await requireDraft(ctx, draftId)
  await settings.assertReady(ctx)
  if (draft.status === 'rejected') return toApi(draft)
  assertTransition('ai_draft', DRAFT_TRANSITIONS, draft.status, 'rejected')
  const comment = String(reason ?? '').trim()
  if (!comment) throw new HttpError(errors.badRequest, { fields: { reason: 'required' } })

  const inst = await approvalStore.pendingInstanceByDoc(ctx, DOC_TYPE, draft.id)
  if (!inst) throw new HttpError(errors.conflict, { reason: '草稿没有在途审批' })
  const tasks = await approvalStore.pendingTasksByInstance(ctx, inst.id)
  if (!tasks.length) throw new HttpError(errors.conflict, { reason: '没有待处理的审批任务' })

  await approval.decide(ctx, tasks[0].id, { action: 'reject', comment })
  return toApi(await store.draftById(ctx, draft.id))
}

/**
 * 工具 → 真实 svc 函数。调用的是与人工操作**完全相同**的函数；
 * 加工具时在这里补一行映射（write 工具本身仍然没有 run）。
 * @type {Record<string, { refType: string, apply: (ctx: any, payload: any) => Promise<any> }>}
 */
const APPLIERS = {
  create_party: { refType: 'party', apply: (ctx, payload) => party.createParty(ctx, payload) },
  // 与人工下采购单完全同一个函数（DESIGN §12.2 步骤 3）
  create_purchase_order: { refType: 'purchase_order', apply: (ctx, payload) => purchase.createPo(ctx, payload) },
}

/** 内部标记：事务会回滚，随后单独把草稿标成 failed（可修复重试） */
class ApplyFailure extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.cause = cause
  }
}

/** @param {unknown} err */
function reasonOf(err) {
  if (err instanceof HttpError) {
    const details = /** @type {any} */ (err.details)
    if (details?.reason) return String(details.reason)
    if (details?.fields) return `${err.zh}：${JSON.stringify(details.fields)}`
    return err.zh
  }
  return err instanceof Error ? err.message : String(err)
}

/**
 * 落库失败后单独写 status='failed' + error（原事务已回滚，不能在同一事务里写）。
 * @param {any} ctx @param {string} id @param {string} reason
 */
async function markFailed(ctx, id, reason) {
  const now = new Date()
  await withTx(ctx, async (tx) => {
    const row = await store.draftByIdForUpdate(tx, id)
    if (!row || (row.status !== 'approved' && row.status !== 'failed')) return
    const n = await store.draftMarkFailed(tx, id, reason, now)
    if (!n) return
    await audit.insert(tx, {
      id: randomUUID(),
      module: 'ai',
      action: 'apply_failed',
      whoId: ctx.userId ?? null,
      refType: 'ai_draft',
      refId: id,
      before: { status: row.status },
      after: { status: 'failed', error: reason },
      traceId: ctx.requestId ?? '',
      at: now,
    })
  })
}

/**
 * 唯一落库入口（DESIGN §12.2）。
 *
 * 1. 事务内 FOR UPDATE 锁草稿（并发 apply 串行化）
 * 2. 重新跑工具 draft()：payload 可能躺了几天，编码/客户状态必须重新校验
 * 3. 调 APPLIERS 里的真实 svc 函数（与人工同一个）
 * 4. 回写 applied_ref / status='applied' + audit_log
 * 5. 失败 → 事务回滚，再单独把草稿标 failed + 可读 error
 *
 * @param {any} ctx @param {string} draftId
 */
export async function apply(ctx, draftId) {
  const id = assertId(draftId)
  // 先 404（跨租户不泄露存在性）再 503（离线降级）
  await requireDraft(ctx, id)
  await settings.assertReady(ctx)
  /** @type {{ row: any, idempotent: boolean }} */
  let outcome

  try {
    outcome = await withTx(ctx, async (tx) => {
      const row = await store.draftByIdForUpdate(tx, id)
      if (!row) throw new HttpError(errors.notFound)

      // 幂等键：同一 draft 只落一单；重复 apply 直接返回原结果
      if (row.status === 'applied') return { row, idempotent: true }

      // approved → applied；failed → applied 是"修好环境后重试"的合法路径
      assertTransition('ai_draft', DRAFT_TRANSITIONS, row.status, 'applied')
      if (await approvalStore.pendingInstanceByDoc(tx, DOC_TYPE, id)) {
        throw new HttpError(errors.conflict, { reason: '审批尚未通过，不能落库' })
      }

      try {
        const name = row.tool_name
        const tool = tools.getTool(name)
        if (!tool) throw new HttpError(errors.conflict, { reason: `工具 ${name} 已不在注册表，无法落库` })
        if (tool.level !== 'write') throw new HttpError(errors.conflict, { reason: `工具 ${name} 不是写工具` })
        const applier = APPLIERS[name]
        if (!applier) throw new HttpError(errors.conflict, { reason: `工具 ${name} 没有落库映射` })

        // 重新校验 payload（草稿可能已过期）；makeDraft 只读不写
        const fresh = await tools.makeDraft(name, jsonOf(row.payload), ctx)
        // nextCode 不能在事务里跑（撞唯一键的重试在 PG aborted 事务上必然失效），
        // 所以在**进事务前**就把编号取好，再交给业务 svc
        const ref = await applier.apply(tx, fresh.payload)

        const now = new Date()
        const n = await store.draftMarkApplied(tx, {
          id,
          expectedVersion: row.version,
          refType: applier.refType,
          refId: ref.id,
          now,
        })
        if (!n) throw new HttpError(errors.conflict, { reason: '草稿已被并发处理' })

        await audit.insert(tx, {
          id: randomUUID(),
          module: 'ai',
          action: 'apply',
          whoId: ctx.userId ?? null,
          refType: 'ai_draft',
          refId: id,
          before: { status: row.status, payload: fresh.payload },
          after: { status: 'applied', appliedRefType: applier.refType, appliedRefId: ref.id },
          traceId: ctx.requestId ?? '',
          at: now,
        })
        return { row: await store.draftById(tx, id), idempotent: false }
      } catch (err) {
        throw new ApplyFailure(err)
      }
    })
  } catch (err) {
    if (!(err instanceof ApplyFailure)) throw err
    const reason = reasonOf(err.cause)
    await markFailed(ctx, id, reason)
    throw new HttpError(errors.conflict, {
      reason: `落库失败：${reason}`,
      draftId: id,
      status: 'failed',
      allowed: ['applied'],
    })
  }

  return { draft: toApi(outcome.row), idempotent: outcome.idempotent }
}

/**
 * @param {any} ctx
 * @param {{ limit: number, order: 'asc'|'desc', cursor: { at: Date, id: string } | null, status?: string, toolName?: string }} page
 */
export async function listDrafts(ctx, page) {
  const rows = await store.draftList(ctx, page)
  const { items, nextCursor } = trimPage(rows, page.limit)
  return { items: items.map(toApi), nextCursor }
}

/** @param {any} ctx @param {string} id */
export async function getDraft(ctx, id) {
  const row = await requireDraft(ctx, id)
  await settings.assertReady(ctx)
  return toApi(row)
}
