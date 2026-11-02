import { createHmac } from 'node:crypto'
import { fetchWithRetry } from './integration_http.mjs'
import { decryptJson } from './integration_crypto.mjs'
import { normalizeProvider } from './integration_providers.mjs'

/**
 * 钉钉群机器人签名：timestamp(ms) + "\n" + secret 做 HMAC-SHA256，base64 后拼进 URL。
 * @param {string} webhookUrl
 * @param {string} secret
 * @param {number} [timestamp]
 */
export function signDingTalkUrl(webhookUrl, secret, timestamp = Date.now()) {
  const sign = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
  const u = new URL(webhookUrl)
  u.searchParams.set('timestamp', String(timestamp))
  u.searchParams.set('sign', sign)
  return u.toString()
}

/**
 * 群机器人推送。只用 webhook，不碰企业应用消息（要审核/IP 白名单，自托管客户做不到）。
 * @param {string} provider
 * @param {{ webhookUrl: string, secret?: string }} target
 * @param {string} text
 * @param {{ timeoutMs?: number, retries?: number, atMobiles?: string[] }} [opts]
 */
export async function sendText(provider, target, text, opts = {}) {
  const p = normalizeProvider(provider)
  if (!target?.webhookUrl) throw new Error('缺少群机器人 webhookUrl')
  const content = String(text ?? '').trim()
  if (!content) throw new Error('推送内容不能为空')

  let url = target.webhookUrl
  /** @type {Record<string, unknown>} */
  let payload

  if (p === 'dingtalk') {
    if (target.secret) url = signDingTalkUrl(url, target.secret)
    payload = { msgtype: 'text', text: { content } }
    if (opts.atMobiles?.length) payload.at = { atMobiles: opts.atMobiles, isAtAll: false }
  } else {
    payload = { msgtype: 'text', text: { content } }
  }

  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    },
    { timeoutMs: opts.timeoutMs, retries: opts.retries },
  )
  const raw = await res.text()
  if (!res.ok) throw new Error(`群机器人返回 HTTP ${res.status}`)

  /** @type {any} */
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    throw new Error('群机器人返回的不是 JSON')
  }
  const errcode = Number(data?.errcode ?? 0)
  if (errcode !== 0) throw new Error(`群机器人推送失败：${data?.errmsg ?? `errcode=${errcode}`}`)
  return data
}

/** 语义更直白的别名；调用方不必知道内部叫 sendText。 */
export const sendGroupText = sendText

/**
 * 从 integration_conn 的加密 secrets 里取出 webhook 配置再推送。
 * @param {any} conn
 * @param {string} text
 * @param {{ timeoutMs?: number, retries?: number, atMobiles?: string[] }} [opts]
 */
export async function sendViaConn(conn, text, opts = {}) {
  if (!conn?.secrets) throw new Error('集成密钥未配置')
  const s = decryptJson(String(conn.secrets))
  const webhookUrl = s.webhook_url ?? s.webhookUrl ?? s.webhook
  const secret = s.webhook_secret ?? s.webhookSecret ?? s.secret
  return sendText(conn.provider, { webhookUrl, secret }, text, opts)
}
