import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { withTx } from '../db/index.mjs'
import * as store from '../store/notify.mjs'
import { deliver, retryDelayMs, MAX_ATTEMPTS } from './notify.mjs'

/**
 * outbox 消费者：单进程 poll（DESIGN §10.1）。
 *
 * 取任务：`FOR UPDATE SKIP LOCKED` + status/next_retry_at，一次 20 条。
 * 领走 = status:'sending' + next_retry_at 当**租约**（5 分钟），worker 崩了租约到期能被下一轮重领，
 * 不会出现「消息永久卡在 sending」。
 *
 * ponytail: DB 当队列，单实例每分钟几千条足够；上量后换外部队列，emit/deliver 接口不变。
 */

export const DEFAULTS = { intervalMs: 2000, batch: 20, leaseMs: 300_000 }

const TITLE = '通知发送失败'

/**
 * @param {{ intervalMs?: number, batch?: number, leaseMs?: number, clock?: () => Date, onError?: (err: unknown) => void }} [opts]
 */
export function createWorker(opts = {}) {
  const intervalMs = Math.max(Number(opts.intervalMs ?? DEFAULTS.intervalMs) || DEFAULTS.intervalMs, 1)
  const batch = Math.min(Math.max(Number(opts.batch ?? DEFAULTS.batch) || DEFAULTS.batch, 1), 200)
  const leaseMs = Number(opts.leaseMs ?? DEFAULTS.leaseMs) || DEFAULTS.leaseMs
  const clock = opts.clock ?? (() => new Date())
  const onError = opts.onError ?? ((/** @type {unknown} */ err) => console.error('[notify-worker]', err))

  /** @type {NodeJS.Timeout | null} */
  let timer = null
  /** @type {Promise<unknown> | null} */
  let inflight = null
  let stopped = true

  /** SIGTERM 时优雅退出：不再取新任务，等在途的这一轮跑完 */
  const onSignal = () => void stop()

  /**
   * 跑一轮。返回本轮统计，便于测试和业务侧按钮「立即发送」。
   */
  async function runOnce() {
    const now = clock()
    const claimed = await withTx({ requestId: 'notify-worker' }, async (tx) => {
      const rows = await store.claimOutbox(tx, now, batch)
      const lease = new Date(now.getTime() + leaseMs)
      // 同事务里改成 sending（行已被 FOR UPDATE 锁住），提交后别的实例就抢不到了
      for (const r of rows) await store.markSending({ ...tx, tenantId: r.tenant_id }, r.id, lease)
      return rows
    })

    const stats = { claimed: claimed.length, sent: 0, retried: 0, failed: 0 }
    for (const row of claimed) {
      const ctx = { tenantId: row.tenant_id, requestId: 'notify-worker', userId: null }
      const vars = /** @type {Record<string, any>} */ (store.parseJson(row.vars) ?? {})
      const job = {
        channel: row.channel,
        toAddr: row.to_addr,
        templateCode: row.template_code,
        subject: vars._subject ?? row.template_code,
        body: vars._body ?? '',
        link: vars._link ?? null,
      }

      try {
        await deliver(ctx, job)
        await store.markSent(ctx, row.id)
        stats.sent++
        continue
      } catch (err) {
        const attempts = Number(row.attempts) + 1
        const message = `${String(/** @type {any} */ (err)?.message ?? err)}`.slice(0, 500)
        if (attempts >= MAX_ATTEMPTS) {
          await store.markRetry(ctx, { id: row.id, attempts, nextRetryAt: null, status: 'failed', error: message })
          await warnAdmins(ctx, row, attempts, message)
          stats.failed++
        } else {
          await store.markRetry(ctx, {
            id: row.id,
            attempts,
            nextRetryAt: new Date(clock().getTime() + retryDelayMs(attempts)),
            status: 'pending',
            error: message,
          })
          stats.retried++
        }
      }
    }
    return stats
  }

  /**
   * 5 次都失败 → 写一条站内信给管理员（owner）。不经 outbox，否则失败会自己喂自己。
   * @param {any} ctx @param {any} row @param {number} attempts @param {string} message
   */
  async function warnAdmins(ctx, row, attempts, message) {
    try {
      const admins = await store.usersByRole(ctx, 'owner')
      for (const a of admins) {
        await store.insertInbox(ctx, {
          id: randomUUID(),
          userId: a.id,
          title: TITLE,
          body: `渠道 ${row.channel} → ${row.to_addr} 连续失败 ${attempts} 次，已停止重试。模板 ${row.template_code}。错误：${message}`,
          link: '/settings/notify',
          now: clock(),
        })
      }
    } catch (err) {
      // 告警都发不出去就只能记日志；不能让 worker 因为告警崩掉
      onError(err)
    }
  }

  function tick() {
    if (stopped) return Promise.resolve(null)
    if (inflight) return inflight
    inflight = runOnce()
      .catch(onError)
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  const api = {
    get running() {
      return !stopped && timer !== null
    },
    get intervalMs() {
      return intervalMs
    },
    runOnce,
    /** @param {{ immediate?: boolean }} [o] */
    start(o = {}) {
      if (timer) return api
      stopped = false
      timer = setInterval(() => void tick(), intervalMs)
      // 别让 worker 的 timer 拖着进程不退出（SIGTERM 时 server 才是该等的东西）
      timer.unref?.()
      process.once('SIGTERM', onSignal)
      process.once('SIGINT', onSignal)
      if (o.immediate !== false) void tick()
      return api
    },
    async stop() {
      stopped = true
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      if (inflight) await inflight.catch(() => {})
    },
  }
  return api
}

/** @type {ReturnType<typeof createWorker> | null} */
let shared = null

function sharedWorker() {
  if (!shared) {
    shared = createWorker({ intervalMs: Number(process.env.NOTIFY_WORKER_INTERVAL_MS) || DEFAULTS.intervalMs })
  }
  return shared
}

/** 供 cmd/server.mjs / 运维脚本调用（本切片不改 server） */
export const start = () => sharedWorker().start()
export const stop = () => sharedWorker().stop()
export const runOnce = () => sharedWorker().runOnce()

// `node svc/notify_worker.mjs` 也能单独起一个消费者进程
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start()
  console.log('[notify-worker] started')
}
