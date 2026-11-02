#!/usr/bin/env node
/**
 * 演示数据种子。可重复执行：已存在的记录会被跳过（409 视为"已存在"）。
 *
 *   node cmd/demo-seed.mjs                      # 默认 demo / boss@demo.cn / demo12345
 *   node cmd/demo-seed.mjs --slug acme --email a@b.c --password xxx
 *
 * 为什么要这个脚本：`migrate up` 从空库重建、或者验证迁移时清库，都会把演示账号一起删掉，
 * 每次手写一堆 curl 既慢又容易漏。
 */
import { close } from '../db/index.mjs'
import { createTenant } from '../svc/tenant.mjs'
import * as settings from '../svc/settings.mjs'
import { config } from '../config.mjs'

const args = process.argv.slice(2)
/** @type {Record<string,string>} */
const opt = {}
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith('--')) break
  opt[args[i].slice(2)] = args[i + 1] ?? ''
}

const slug = opt.slug ?? 'demo'
const email = opt.email ?? 'boss@demo.cn'
const password = opt.password ?? 'demo12345'
const name = opt.name ?? '演示集成'
// 注意：环境里的 PORT 可能被别的服务占用（本机 8080 是 Pi Web），
// 显式打印目标地址，串端口时一眼看得出来
const port = opt.port ? Number(opt.port) : config.port
const base = `http://127.0.0.1:${port}`
console.log(`目标服务：${base}`)

// ── 1. 确保公司 + 账号存在 ────────────────────────────────────────────────
const ctx0 = { requestId: 'seed', userId: null }
try {
  const out = await createTenant(ctx0, { slug, name, email, password, displayName: '老板' })
  console.log(`建公司 ${slug}（${out.tenantId}），owner ${email}`)
} catch (err) {
  console.log(`公司/账号已存在或无法创建：${/** @type {Error} */ (err).message}`)
}

// ── 2. 登录拿 cookie ──────────────────────────────────────────────────────
async function tryLogin() {
  return fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
}
let login = await tryLogin()
if (!login.ok) {
  // 刚建完号立刻登录偶发一次 401（读连接池的时序），重试一次就稳
  await new Promise((r) => setTimeout(r, 300))
  login = await tryLogin()
}
if (!login.ok) {
  console.error(`登录失败（${login.status}）：服务起来了吗？node cmd/server.mjs`)
  await close()
  process.exit(1)
}
const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
console.log(`登录成功 ${email}`)

/** @param {string} method @param {string} path @param {unknown} [body] */
async function api(method, path, body) {
  const res = await fetch(`${base}/t/${slug}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

/** 已存在（409）当成功，其它非 2xx 打日志但不中断 */
async function ensure(/** @type {string} */ label, /** @type {() => Promise<{status:number, body:any}>} */ fn) {
  const r = await fn()
  if (r.status >= 400 && r.status !== 409) {
    console.log(`  ! ${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`)
    return null
  }
  return r.body
}

// ── 3. 主数据（编号现在自动生成，不用手编）────────────────────────────────
console.log('主数据…')
const c1 = await ensure('客户1', () => api('POST', '/api/parties', { name: '市政数局', partyType: 'customer', contactName: '李工', phone: '13900000001' }))
const c2 = await ensure('客户2', () => api('POST', '/api/parties', { name: '省交投集团', partyType: 'customer', contactName: '王主任' }))
const sup = await ensure('供应商', () => api('POST', '/api/parties', { name: '华三通信', partyType: 'supplier', contactName: '张经理' }))
const it1 = await ensure('物料1', () => api('POST', '/api/items', { name: '48口接入交换机', spec: '48GE', baseUom: '台', category: '网络' }))
const it2 = await ensure('物料2', () => api('POST', '/api/items', { name: '下一代防火墙', spec: '1U', baseUom: '台', category: '安全' }))
const wh = await ensure('仓库', () => api('POST', '/api/warehouses', { name: '主仓' }))

if (it1?.id && wh?.id) {
  await ensure('入库', () => api('POST', '/api/stock/moves', {
    warehouseId: wh.id, itemId: it1.id, qty: '20', dir: 'in', moveType: 'init', unitCost: '5000.00',
  }))
}

// ── 4. 项目主链：商机 → 赢单 → 立项 → 需求/方案/报价/合同 ──────────────────
console.log('项目主链…')
const opp = await ensure('商机', () => api('POST', '/api/opportunities', {
  name: '政务云平台一期', partyId: c1?.id, estAmount: '1200000.00',
}))
let project = null
if (opp?.id) {
  await ensure('商机跟进', () => api('POST', `/api/opportunities/${opp.id}/advance`, { to: 'following' }))
  const won = await ensure('商机赢单', () => api('POST', `/api/opportunities/${opp.id}/advance`, { to: 'won' }))
  project = won?.project ?? null
}

if (project?.id) {
  for (const to of ['approved', 'designing', 'quoting']) {
    await ensure(`项目→${to}`, () => api('POST', `/api/projects/${project.id}/advance`, { to }))
  }
  const req = await ensure('需求', () => api('POST', '/api/requirements', {
    projectId: project.id, title: '政务云需求调研', content: '三级等保 / 双活 / 迁移 200 台虚机',
  }))
  if (req?.id) await ensure('需求确认', () => api('POST', `/api/requirements/${req.id}/advance`, { to: 'confirmed' }))

  const doc = await ensure('方案', () => api('POST', '/api/design-docs', {
    projectId: project.id,
    title: '政务云拓扑方案',
    content: '核心双机 + 汇聚',
    bomLines: [
      { lineNo: 1, itemName: '核心交换机', spec: '48口', uom: '台', qty: 4, unitCost: '68000.00' },
      { lineNo: 2, itemName: '虚拟化节点', spec: '2U', uom: '台', qty: 12, unitCost: '42000.00' },
    ],
  }))
  if (doc?.id) {
    await ensure('方案确认', () => api('POST', `/api/design-docs/${doc.id}/advance`, { to: 'confirmed' }))
    const quo = await ensure('报价', () => api('POST', '/api/quotations', { designDocId: doc.id }))
    if (quo?.id) {
      await ensure('报价发出', () => api('POST', `/api/quotations/${quo.id}/advance`, { to: 'sent' }))
      await ensure('报价接受', () => api('POST', `/api/quotations/${quo.id}/advance`, { to: 'accepted' }))
      const con = await ensure('合同', () => api('POST', '/api/contracts', {
        quotationId: quo.id,
        code: `HT-${new Date().getUTCFullYear()}-001`,
        name: '政务云平台一期建设合同',
        terms: [{ title: '总价', content: '含税 776000 元' }, { title: '质保', content: '验收后一年' }],
      }))
      if (con?.id) await ensure('签约', () => api('POST', `/api/contracts/${con.id}/advance`, { to: 'signed' }))
    }
  }
}

// ── 5. 审批流程 + 通知配置 ────────────────────────────────────────────────
console.log('审批与通知…')
await ensure('审批流程', () => api('POST', '/api/approval/flows', {
  code: 'PO_OVER_50K',
  name: '采购单超 5 万两级审批',
  docType: 'PURCHASE_ORDER',
  enabled: true,
  steps: [
    { no: 1, approver_type: 'role', approver_ref: 'owner', mode: 'any', min_amount: '50000.00', max_amount: null },
    { no: 2, approver_type: 'role', approver_ref: 'owner', mode: 'any', min_amount: '50000.00', max_amount: null },
  ],
}))
await ensure('站内信渠道', () => api('POST', '/api/notify/channels', { type: 'inapp', enabled: true, config: {} }))
for (const [code, subject, body] of [
  ['approval.pending', '待你审批：{{docType}}', '金额 {{amount}}，第 {{stepNo}} 级'],
  ['approval.approved', '已通过：{{docType}}', '金额 {{amount}}'],
  ['approval.rejected', '已驳回：{{docType}}', '金额 {{amount}}'],
  ['approval.failed', '落库失败：{{docType}}', '金额 {{amount}}'],
]) {
  await ensure(`模板 ${code}`, () => api('POST', '/api/notify/templates', { code, channel: 'inapp', lang: 'zh', subject, body }))
}

// ── 6. 采购（会走审批，审批中心能看到待办）──────────────────────────────
console.log('采购…')
if (sup?.id && it1?.id) {
  const po = await ensure('采购单', () => api('POST', '/api/purchase-orders', {
    partyId: sup.id,
    lines: [
      { itemId: it1.id, qty: '10', price: '5000.00' },
      { itemId: it2.id, qty: '2', price: '30000.00' },
    ],
  }))
  if (po?.id) await ensure('采购提交审批', () => api('POST', `/api/purchase-orders/${po.id}/submit`, {}))
}

// ── 7. 施工 ───────────────────────────────────────────────────────────────
console.log('施工…')
if (project?.id) {
  const plan = await ensure('施工计划', () => api('POST', '/api/work-plans', {
    projectId: project.id, name: '机房与网络施工', planStart: '2026-08-01', planEnd: '2026-10-31',
  }))
  if (plan?.id) {
    for (const title of ['机柜上架', '综合布线', '设备上电调试']) {
      await ensure(`任务 ${title}`, () => api('POST', '/api/work-tasks', {
        planId: plan.id, title, planStart: '2026-08-01', planEnd: '2026-09-15',
      }))
    }
  }
  const me = /** @type {any} */ ((await api('GET', '/api/me')).body)?.user
  if (me?.id) {
    for (const [workDate, hours, note] of [['2026-08-05', '8', '机柜上架'], ['2026-08-06', '6.5', '布线']]) {
      await ensure(`工时 ${workDate}`, () => api('POST', '/api/labor-hours', { projectId: project.id, userId: me.id, workDate, hours, note }))
    }
  }
}

// ── 8. 售后 ───────────────────────────────────────────────────────────────
console.log('售后…')
if (c1?.id) {
  const sc = await ensure('服务合同', () => api('POST', '/api/service-contracts', {
    partyId: c1.id, name: '政务云维保', startAt: '2026-01-01', endAt: '2027-01-01',
    slaLevel: 'gold', responseMinutes: 30, resolveMinutes: 240, amount: '80000.00',
  }))
  await ensure('工单', () => api('POST', '/api/tickets', {
    title: '核心交换机告警', content: '端口 err-disable', priority: 'high', sn: 'SN-0001',
    partyId: c1.id, contractId: sc?.id,
  }))
}

// ── 9. 注册策略回到默认（种子里不改它，只提示）─────────────────────────────
await settings.resetCache()

console.log(`\n完成。打开 http://<你的地址>:${port}/ 用 ${email} / ${password} 登录`)
await close()
