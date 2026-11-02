import * as notify from './notify.mjs'
import * as store from '../store/approval.mjs'

/**
 * 审批 → 通知的桥。两个域各自独立（审批切片不 import 通知域，通知切片不知道审批），
 * 由主线在 API 层把它们接起来 —— 这样两边都能单独测。
 *
 * DESIGN §10.5 的事件集：approval.pending / approval.approved / approval.rejected
 */

/** @type {Record<string,string>} */
const DOC_LABEL = {
  QUOTATION: '报价',
  PURCHASE_ORDER: '采购单',
  MATERIAL_ISSUE: '领料单',
  CHANGE_ORDER: '变更签证',
  SUBCONTRACT_PROGRESS: '分包进度款',
  AI_DRAFT: 'AI 草稿',
}

/** @param {any} instance @param {number} stepNo */
function stepOf(instance, stepNo) {
  // 库里的行是 flowSnapshot.steps（snake_case），API 返回的是 steps（camelCase），两种都要认
  const steps = instance?.flowSnapshot?.steps ?? instance?.steps ?? []
  return steps.find((/** @type {any} */ s) => s.no === stepNo) ?? null
}

/** @param {any} step */
const stepType = (step) => String(step?.approver_type ?? step?.approverType ?? '')
/** @param {any} step */
const stepRef = (step) => step?.approver_ref ?? step?.approverRef ?? null

/**
 * 把流程里的审批人声明翻成通知中心的收件人描述。
 * role → { role }：该角色任何人都能在待办里看到，所以通知也是发给角色
 * user → { userId }
 * manager → 已经在审批侧解析成具体任务了，这里用任务里的 approver_user_id
 * @param {any} ctx
 * @param {any} instance
 */
async function recipientsForStep(ctx, instance) {
  const step = stepOf(instance, Number(pick(instance, 'current_step', 'currentStep')))
  if (!step) return []
  if (stepType(step) === 'field') return []
  // 审批侧解析出来的待办人最准（userId），其次才是声明（role/user）
  const tasks = await pendingApprovers(ctx, String(pick(instance, 'id', 'id')), step.no)
  if (tasks.length) return tasks.map((/** @type {string} */ uid) => ({ userId: uid }))
  if (stepType(step) === 'role') return [{ role: stepRef(step) }]
  if (stepType(step) === 'user') return [{ userId: stepRef(step) }]
  return []
}

/** @param {any} ctx @param {string} instanceId @param {number} stepNo */
async function pendingApprovers(ctx, instanceId, stepNo) {
  const rows = await store.tasksByStep(ctx, instanceId, stepNo)
  return rows
    .filter((/** @type {any} */ t) => t.status === 'pending' && t.approver_user_id)
    .map((/** @type {any} */ t) => t.approver_user_id)
}

/**
 * 实例对象有两种形态：库里的行（snake_case）和 API 返回（camelCase）。
 * 桥接层两种都要吃得下 —— 否则 submit 路径能发、apply 路径静默不发。
 * @param {any} o @param {string} a @param {string} b
 */
const pick = (o, a, b) => (o?.[a] !== undefined && o?.[a] !== null ? o[a] : o?.[b])

/** @param {any} instance */
const docTypeOf = (instance) => String(pick(instance, 'doc_type', 'docType') ?? '')
/** @param {any} instance */
const label = (instance) => DOC_LABEL[docTypeOf(instance).toUpperCase()] ?? docTypeOf(instance)

/**
 * 审批到了某一级 → 通知该级审批人。
 * 事务外调用：通知只是副作用，落库失败不能把审批回滚。
 * @param {any} ctx
 * @param {any} instance
 */
export async function emitPending(ctx, instance) {
  if (!instance?.id) return
  const recipients = await recipientsForStep(ctx, instance)
  if (!recipients.length) return
  await notify.emit(ctx, 'approval.pending', {
    docId: String(pick(instance, 'doc_id', 'docId') ?? ''),
    step: String(pick(instance, 'current_step', 'currentStep') ?? ''),
    recipients,
    vars: {
      docType: label(instance),
      amount: instance.amount,
      stepNo: pick(instance, 'current_step', 'currentStep'),
      docId: pick(instance, 'doc_id', 'docId'),
    },
  })
}

/**
 * 审批结束（通过/拒绝）→ 通知提交人。
 * @param {any} ctx
 * @param {any} instance
 * @param {'approve'|'reject'} action
 */
export async function emitFinished(ctx, instance, action) {
  const submitter = pick(instance, 'submitter_id', 'submitterId')
  if (!submitter) return
  const event = action === 'approve' ? 'approval.approved' : 'approval.rejected'
  await notify.emit(ctx, event, {
    docId: String(pick(instance, 'doc_id', 'docId') ?? ''),
    recipients: [{ userId: submitter }],
    vars: { docType: label(instance), amount: instance.amount, result: event },
  })
}
