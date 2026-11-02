/**
 * 审批域对外的极小事件口子。
 *
 * 为什么不是直接在 svc/approval.mjs 里 import 通知域：两个域要能各自单独测。
 * 所以审批只负责"喊一声"，谁关心谁自己注册 —— 通知桥（svc/approval_notify.mjs）
 * 在启动时 install()，测试里由 helpers 装。
 *
 * 触发点都在**事务提交之后**：通知失败不能把审批回滚。
 */

/** @type {{ event: string, fn: (ctx: any, payload: any) => unknown }[]} */
const listeners = []

/**
 * @param {'submitted'|'decided'} event
 * @param {(ctx: any, payload: any) => unknown} fn
 */
export function on(event, fn) {
  listeners.push({ event, fn })
}

/**
 * @param {'submitted'|'decided'} event
 * @param {any} ctx
 * @param {any} payload
 */
export async function emit(event, ctx, payload) {
  for (const l of listeners) {
    if (l.event !== event) continue
    try {
      await l.fn(ctx, payload)
    } catch {
      // 监听器自己的异常不能影响审批主流程；失败由监听器内部记录
    }
  }
}

/** 测试隔离用 */
export function reset() {
  listeners.length = 0
}
