import { createHmac } from 'node:crypto'
import { ChannelError, postJson } from './notify_http.mjs'

/**
 * 群机器人 webhook（DESIGN §11.1：优先群机器人，不用企业应用消息）。
 *
 * 钉钉：有 `secret` 时加签 `timestamp + sign`，sign = base64(HMAC-SHA256(secret, `${ts}\n${secret}`))。
 * 企微：纯 webhook，URL 自带 key。
 *
 * 两者都是「群级」投递，不区分人 —— outbox 里 to_addr 只放群标识。
 */

export const channel = 'dingtalk'

/**
 * 钉钉签名（导出便于单测/排障）
 * @param {string} secret
 * @param {number} timestamp 毫秒
 */
export function dingtalkSign(secret, timestamp) {
  return createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
}

/** @param {string} text */
const textBody = (/** @type {string} */ text) => ({ msgtype: 'text', text: { content: text } })

/** @param {{ subject?: string, body?: string }} job */
const renderText = (job) => [job.subject, job.body].filter(Boolean).join('\n')

/**
 * @param {{ subject?: string, body?: string }} job
 * @param {Record<string, unknown>} cfg
 */
export async function sendDingtalk(job, cfg) {
  const raw = String(cfg.webhook ?? '')
  if (!raw) throw new ChannelError('dingtalk 渠道未配置 webhook')
  /** @type {URL} */
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ChannelError('dingtalk webhook 不是合法 URL')
  }
  const secret = String(cfg.secret ?? '')
  if (secret) {
    const ts = Date.now()
    url.searchParams.set('timestamp', String(ts))
    url.searchParams.set('sign', dingtalkSign(secret, ts))
  }
  const res = await postJson(url.toString(), textBody(renderText(job)), { timeoutMs: 15_000 })
  assertBotOk(res.text, '钉钉')
  return { ok: true, status: res.status }
}

/**
 * @param {{ subject?: string, body?: string }} job
 * @param {Record<string, unknown>} cfg
 */
export async function sendWecom(job, cfg) {
  const raw = String(cfg.webhook ?? '')
  if (!raw) throw new ChannelError('wecom 渠道未配置 webhook')
  /** @type {URL} */
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ChannelError('wecom webhook 不是合法 URL')
  }
  const res = await postJson(url.toString(), textBody(renderText(job)), { timeoutMs: 15_000 })
  assertBotOk(res.text, '企业微信')
  return { ok: true, status: res.status }
}

/**
 * 群机器人 HTTP 200 不代表成功：钉钉/企微都用 body 里的 errcode 表意。
 * @param {string} text
 * @param {string} who
 */
function assertBotOk(text, who) {
  /** @type {any} */
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    return // 不是 JSON 就不猜，交给上层超时/状态码判断
  }
  if (body?.errcode !== undefined && Number(body.errcode) !== 0) {
    throw new ChannelError(`${who}返回错误 errcode=${body.errcode} ${body.errmsg ?? ''}`.trim())
  }
}

/** 渠道名 → 投递函数（worker 用） */
export const SENDERS = {
  dingtalk: sendDingtalk,
  wecom: sendWecom,
}
