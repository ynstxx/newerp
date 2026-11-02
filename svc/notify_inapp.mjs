import { randomUUID } from 'node:crypto'
import { insertInbox } from '../store/notify.mjs'
import { ChannelError } from './notify_http.mjs'

/**
 * 站内信：直接写 notify_inbox（DESIGN §10.3）。
 * 不做 SSE —— 前端未读轮询兜底就够，SSE 留给主线接。
 */

export const channel = 'inapp'

/**
 * @param {any} ctx 已带 tenantId 的上下文
 * @param {{ toAddr: string, subject?: string, body?: string, link?: string | null, templateCode?: string }} job
 */
export async function send(ctx, job) {
  if (!job.toAddr) throw new ChannelError('站内信缺少收件人 user id')
  await insertInbox(ctx, {
    id: randomUUID(),
    userId: job.toAddr,
    title: job.subject || job.templateCode || '通知',
    body: job.body || null,
    link: job.link ?? null,
    now: new Date(),
  })
  return { ok: true }
}
