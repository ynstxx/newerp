import { HttpError, errors } from '../http/errors.mjs'

/**
 * 状态机唯一裁判。每个实体在 svc/<实体>.mjs 里定义一张 TRANSITIONS，
 * 非法跳转一律 409 并带上允许的目标 —— 前端据此只渲染合法按钮。
 *
 * @param {string} name 实体名，用于错误信息
 * @param {Record<string, readonly string[]>} transitions
 * @param {string} from
 * @param {string} to
 */
export function assertTransition(name, transitions, from, to) {
  const allowed = transitions[from] ?? []
  if (allowed.includes(to)) return
  throw new HttpError(errors.conflict, {
    reason: `${name} 不允许从 ${from} 变到 ${to}`,
    allowed: [...allowed],
  })
}

/**
 * 当前状态能去哪，给 API 返回和前端渲染用
 * @param {Record<string, readonly string[]>} transitions
 * @param {string} from
 */
export const allowedNext = (transitions, from) => [...(transitions[from] ?? [])]
