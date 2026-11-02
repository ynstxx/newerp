import { createHash, randomUUID } from 'node:crypto'
import { hashPassword } from '../auth/password.mjs'
import { withTx } from '../db/index.mjs'
import { HttpError, errors } from '../http/errors.mjs'
import * as audit from '../store/audit.mjs'
import * as store from '../store/integration.mjs'
import * as users from '../store/user.mjs'
import { accessToken, listDepartments, listUsers } from './integration_api.mjs'
import { decryptJson } from './integration_crypto.mjs'
import { normalizeProvider } from './integration_providers.mjs'

/**
 * 外部成员状态归一。钉钉用 active；企微 status=1 为正常，2/4/5 为停用/未激活/离职。
 * @param {any} u
 */
function isActive(u) {
  if (u?.active === false) return false
  const s = String(u?.status ?? '').toLowerCase()
  return !['disabled', 'inactive', 'left', 'deleted', '2', '4', '5'].includes(s)
}

/** @param {any} u */
const externalUserId = (u) => String(u?.userid ?? u?.user_id ?? u?.id ?? '').trim()

/**
 * 外部没给邮箱时造一个不可投递的本地登录名；同一外部 id 永远得到同一地址。
 * @param {string} provider @param {string} externalId @param {string} tenantId
 */
function fallbackEmail(provider, externalId, tenantId) {
  const safe = externalId.toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 20) || 'user'
  // 带上租户短码：两个租户接同一个外部目录时，externalId 相同，不能算出同一个全局邮箱
  const tail = createHash('sha1').update(`${tenantId}|${externalId}`).digest('hex').slice(0, 8)
  // auth_user.email 是 code(64)，fallback 必须留出余量，否则一个人没邮箱就炸整个事务
  return `${safe}-${tail}@${provider}.local`
}

/**
 * 外部邮箱也可能超 64 字符；超长时退回不可投递的本地登录名。
 * @param {string} provider @param {string} externalId @param {unknown} rawEmail @param {string} tenantId
 */
function localEmail(provider, externalId, rawEmail, tenantId) {
  const email = rawEmail ? String(rawEmail).trim().toLowerCase() : ''
  if (email && email.length <= 64 && !/[\s\u0000]/.test(email)) return email
  return fallbackEmail(provider, externalId, tenantId)
}

/**
 * 单个人：命中 map → 更新；没命中 → 建 auth_user + org_membership + map。
 * 角色不覆盖：已有 org_membership.role_id 原样保留。
 * @param {any} tx
 * @param {string} provider
 * @param {{ externalId: string, name: string, email: string, active: boolean }} u
 * @param {Date} at
 * @param {{ created: number, updated: number, disabled: number }} counts
 */
async function applyUser(tx, provider, u, at, counts) {
  const map = await store.mapByKey(tx, { provider, externalType: 'user', externalId: u.externalId })
  let user = map ? await store.userById(tx, map.local_id) : null
  if (!user) {
    // 邮箱是**全局**唯一（auth_user 无 tenant_id）。直接按邮箱认人会把别租户的账户
    // 认成本租户的人，然后改他名字、把他挂进本租户 —— 必须再断言「已是我方成员」。
    const byEmail = await store.userByEmail(tx, u.email)
    if (byEmail && (await store.membershipByUser(tx, byEmail.id))) user = byEmail
  }

  if (!user) {
    const id = randomUUID()
    const { hash, salt } = await hashPassword(`${randomUUID()}${randomUUID()}`)
    await users.insert(tx, {
      id,
      email: u.email,
      pwdHash: hash,
      pwdSalt: salt,
      displayName: u.name,
      status: 'active',
      createdAt: at,
    })
    user = { id, email: u.email, display_name: u.name, status: 'active' }
  } else {
    if (user.display_name !== u.name) await store.updateUserName(tx, user.id, u.name)
    if (u.email && user.email !== u.email) {
      const other = await store.userByEmail(tx, u.email)
      // 邮箱是全局唯一身份：被别人占用时宁可不改，也不要把两个外部人并成一个
      if (!other || other.id === user.id) await store.updateUserEmail(tx, user.id, u.email)
    }
  }

  if (map) {
    await store.touchMap(tx, map.id, at)
    if (map.local_id !== user.id) await store.remap(tx, map.id, user.id, at)
    counts.updated += 1
  } else {
    await store.insertMap(tx, {
      id: randomUUID(),
      provider,
      externalType: 'user',
      externalId: u.externalId,
      localId: user.id,
      syncedAt: at,
    })
    counts.created += 1
  }

  const mem = await store.membershipByUser(tx, user.id)
  const want = u.active ? 'active' : 'disabled'
  if (!mem) {
    await store.insertMembership(tx, { userId: user.id, roleId: null, status: want, joinedAt: at })
  } else if (mem.status !== want) {
    await store.setMembershipStatus(tx, user.id, want)
    if (want === 'disabled') counts.disabled += 1
  }
}

/**
 * 组织架构与人员同步（外部 → 本地）。所有 HTTP 在事务外完成，DB 写入一个事务。
 * @param {any} ctx
 * @param {string} provider
 * @param {{ fetchBaseUrl?: string, baseUrl?: string }} [opts] 测试把 base 指到本地假服务器
 * @returns {Promise<{depts:number, users:number, created:number, updated:number, disabled:number, failed:number}>}
 */
export async function syncOrg(ctx, provider, opts = {}) {
  const p = normalizeProvider(provider)
  const conn = await store.connByProvider(ctx, p)
  if (!conn) throw new HttpError(errors.notFound, { reason: `未配置 ${p} 集成` })
  if (!conn.enabled) throw new HttpError(errors.conflict, { reason: `${p} 集成未启用` })

  /** @type {{depts:number, users:number, created:number, updated:number, disabled:number, failed:number}} */
  const counts = { depts: 0, users: 0, created: 0, updated: 0, disabled: 0, failed: 0 }
  const base = opts.fetchBaseUrl ?? opts.baseUrl ?? ctx?.integrationFetchBaseUrl ?? ctx?.fetchBaseUrl

  try {
    if (!conn.secrets) throw new Error('集成密钥未配置')
    const secrets = decryptJson(String(conn.secrets))
    // corp_id 单独一列，企微 gettoken 需要它；secrets 里没有时用连接上的
    const token = await accessToken(p, { ...secrets, corpid: secrets.corpid ?? secrets.corp_id ?? conn.corp_id }, base)
    const allDepts = await listDepartments(p, token, base)
    counts.depts = allDepts.length
    // external_id 列是 code(64)：超长数据直接算失败，别让它把整个事务打挂
    const depts = allDepts.filter((d) => d.id.length <= 64)
    counts.failed += allDepts.length - depts.length

    /** @type {Map<string, { raw: any, deptId: string }>} */
    const externallySeen = new Map()
    let allDeptsOk = depts.length > 0

    for (const d of depts) {
      try {
        const list = await listUsers(p, token, d.id, base)
        for (const raw of list) {
          const externalId = externalUserId(raw)
          if (!externalId || externalId.length > 64) {
            counts.failed += 1
            continue
          }
          // 一个人可能在多个部门：按外部 userid 去重，不重复建本地账号
          externallySeen.set(externalId, { raw, deptId: d.id })
        }
      } catch {
        counts.failed += 1
        allDeptsOk = false
      }
    }
    counts.users = externallySeen.size

    await withTx(ctx, async (tx) => {
      const at = new Date()

      // 1) 部门映射：本仓库尚无 org_dept 表，local_id 先记外部部门 id，
      //    这样部门树本身仍然有稳定的外部↔本地映射，不会被重复处理。
      for (const d of depts) {
        const m = await store.mapByKey(tx, { provider: p, externalType: 'dept', externalId: d.id })
        if (m) await store.touchMap(tx, m.id, at)
        else
          await store.insertMap(tx, {
            id: randomUUID(),
            provider: p,
            externalType: 'dept',
            externalId: d.id,
            localId: d.id,
            syncedAt: at,
          })
      }

      // 2) 成员：外部为准更新姓名/邮箱/状态；角色不覆盖
      for (const [externalId, { raw }] of externallySeen) {
        try {
          await applyUser(
            tx,
            p,
            {
              externalId,
              name: String(raw.name ?? raw.display_name ?? externalId).slice(0, 64),
              email: localEmail(p, externalId, raw.email, String(tx.tenantId)),
              active: isActive(raw),
            },
            at,
            counts,
          )
        } catch {
          counts.failed += 1
        }
      }

      // 3) 外部删除/停用的成员 → disabled，绝不物理删（历史单据要留人）。
      //    只有全部部门都拉成功才做全量对比，避免一次网络抖动把全员停用。
      if (allDeptsOk) {
        for (const m of await store.mapsOf(tx, p, 'user')) {
          if (externallySeen.has(m.external_id)) continue
          const mem = await store.membershipByUser(tx, m.local_id)
          if (mem && mem.status === 'active') {
            await store.setMembershipStatus(tx, m.local_id, 'disabled')
            counts.disabled += 1
          }
        }
      }

      await store.touchLastSync(tx, conn.id, at)
      const error = counts.failed ? `${counts.failed} 个部门/成员同步失败` : null
      await store.insertLog(tx, { id: randomUUID(), provider: p, action: 'sync', counts, error, at })
      await audit.insert(tx, {
        id: randomUUID(),
        module: 'integration',
        action: 'sync',
        whoId: ctx.userId ?? null,
        refType: 'integration_conn',
        refId: conn.id,
        before: null,
        after: { provider: p, counts },
        traceId: ctx.requestId ?? '',
        at,
      })
    })

    return counts
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const at = new Date()
    // 失败也要留痕，后台才能解释"为什么昨晚没同步"。
    await withTx(ctx, async (tx) => {
      await store.insertLog(tx, { id: randomUUID(), provider: p, action: 'sync', counts, error: message, at })
      await audit.insert(tx, {
        id: randomUUID(),
        module: 'integration',
        action: 'sync_failed',
        whoId: ctx.userId ?? null,
        refType: 'integration_conn',
        refId: conn.id,
        before: null,
        after: { provider: p, counts, error: message },
        traceId: ctx.requestId ?? '',
        at,
      })
    }).catch(() => {})
    if (err instanceof HttpError) throw err
    throw new HttpError(errors.badRequest, { reason: `同步失败：${message}` })
  }
}
