import { ChannelError, postJson } from './notify_http.mjs'

/**
 * 邮件 · HTTP API（Resend 兼容端点：`POST {base_url}/emails` + `Authorization: Bearer <api_key>`）。
 *
 * SMTP 手写（≈250 行）不在本切片：内网自托管客户只有内部邮件服务器时才用得上，
 * 那一批会单独补 `svc/notify_email_smtp.mjs`，渠道接口保持不变，worker 无感。
 *
 * ponytail: SendGrid/Mailgun 只是 path 和 body 形状不同，等真要支持再抽一个 `toBody` 映射，
 * 现在多写两套等于给没人用的分支做维护。
 */

export const channel = 'email'

/**
 * @param {{ toAddr: string, subject?: string, body?: string }} job
 * @param {Record<string, unknown>} cfg 已解密的渠道配置
 */
export async function send(job, cfg) {
  const apiKey = String(cfg.api_key ?? cfg.apiKey ?? '')
  const from = String(cfg.from ?? '')
  const baseUrl = String(cfg.base_url ?? 'https://api.resend.com').replace(/\/+$/, '')
  const path = String(cfg.path ?? '/emails')
  if (!apiKey) throw new ChannelError('email 渠道未配置 api_key')
  if (!from) throw new ChannelError('email 渠道未配置 from')
  if (!job.toAddr || !job.toAddr.includes('@')) throw new ChannelError(`收件人不是邮箱：${job.toAddr}`)

  const body = {
    from,
    to: [job.toAddr],
    subject: job.subject || '(无主题)',
    text: job.body ?? '',
    ...(cfg.reply_to ? { reply_to: String(cfg.reply_to) } : {}),
  }
  const res = await postJson(`${baseUrl}${path}`, body, {
    headers: { authorization: `Bearer ${apiKey}` },
    timeoutMs: Number(cfg.timeout_ms ?? 0) || undefined,
  })
  return { ok: true, status: res.status, id: safeId(res.text) }
}

/** @param {string} text */
function safeId(text) {
  try {
    return /** @type {any} */ (JSON.parse(text)).id ?? null
  } catch {
    return null
  }
}
