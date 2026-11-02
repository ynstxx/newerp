/**
 * 业务域只注册回调，不关心链路（DESIGN §9.3）。
 * 回调在 decide 的事务内执行：业务单据的状态与审批结果同生共死。
 */

const registry = new Map()

/**
 * @param {string} docType
 * @param {{ onApproved?: (ctx: any, docType: string, docId: string, instance: any) => unknown,
 *           onRejected?: (ctx: any, docType: string, docId: string, instance: any) => unknown,
 *           onFailed?: (ctx: any, docType: string, docId: string, instance: any, reason: string) => unknown }} handlers
 */
export function register(docType, handlers) {
  const key = String(docType ?? '').trim().toUpperCase()
  if (!key) throw new Error('register: docType 不能为空')
  if (
    !handlers ||
    (typeof handlers.onApproved !== 'function' && typeof handlers.onRejected !== 'function' && typeof handlers.onFailed !== 'function')
  ) {
    throw new Error(`register(${key}): 至少要给 onApproved / onRejected / onFailed 之一`)
  }
  registry.set(key, handlers)
}

/**
 * @param {'approve'|'reject'} action
 * @param {any} ctx 事务上下文
 * @param {any} instance approval_instance 行
 */
export async function run(action, ctx, instance) {
  const key = String(instance?.doc_type ?? '').trim().toUpperCase()
  const h = registry.get(key)
  const fn = action === 'approve' ? h?.onApproved : h?.onRejected
  if (typeof fn !== 'function') return false
  await fn(ctx, instance.doc_type, instance.doc_id, instance)
  return true
}

/** 测试隔离用 */
export function reset() {
  registry.clear()
}

/** 已注册的 docType（诊断用） */
export const registered = () => [...registry.keys()]

/**
 * 钩子失败后的业务补偿（在**独立事务**里跑，此时审批决定已回滚）。
 * 业务侧在这里把单据落 failed 并做补偿流水，或者什么都不做。
 * @param {any} ctx
 * @param {any} instance
 * @param {string} reason
 */
export async function runFailed(ctx, instance, reason) {
  const key = String(instance?.doc_type ?? '').trim().toUpperCase()
  const fn = registry.get(key)?.onFailed
  if (typeof fn !== 'function') return false
  await fn(ctx, instance.doc_type, instance.doc_id, instance, reason)
  return true
}
