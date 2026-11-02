import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { makeApp, jsonOf } from './helpers.mjs'
import { createTenant } from '../svc/tenant.mjs'
import { close, connect, one, q } from '../db/index.mjs'
import { callRead, getTool, registerTool } from '../svc/ai_tools.mjs'
import { decrypt } from '../svc/ai_crypto.mjs'
import * as partyStore from '../store/party.mjs'
import * as partySvc from '../svc/party.mjs'

const password = 'test-pass-123'
const run = randomUUID().slice(0, 8)
const ownerA = `ai-${run}@example.com`
const ownerB = `aib-${run}@example.com`
const slugA = `ai${run}`
const slugB = `aib${run}`
const codeA = `AIC${run}`.toUpperCase()
const codeB = `AIR${run}`.toUpperCase()
const codeF = `AIF${run}`.toUpperCase()
const API_KEY = 'sk-test-secret-do-not-echo'

/** @type {any} */
let app
let dbUp = false
/** @type {string} */
let cookieA = ''
/** @type {string} */
let cookieB = ''
/** @type {any} */
let tenantA
/** @type {any} */
let tenantB
/** @type {string} */
let draftId = ''

/** @type {{ queue: any[], requests: any[] }} */
const fake = { queue: [], requests: [] }
/** @type {import('node:http').Server} */
let fakeServer
/** @type {string} */
let fakeBase = ''

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function reply(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) })
  res.end(json)
}

const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }

/** @param {any} spec */
function llmBody(spec) {
  if (spec?.tool) {
    return {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `call_${fake.requests.length}`,
                type: 'function',
                function: { name: spec.tool, arguments: JSON.stringify(spec.args ?? {}) },
              },
            ],
          },
        },
      ],
      usage,
    }
  }
  return { choices: [{ message: { role: 'assistant', content: spec?.content ?? '收到' } }], usage }
}

async function startFake() {
  fakeServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    /** @type {Buffer[]} */
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    /** @type {any} */
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = raw
    }
    fake.requests.push({
      method: req.method ?? 'GET',
      path: url.pathname,
      authorization: req.headers.authorization,
      body,
    })
    if (url.pathname !== '/v1/chat/completions') return reply(res, 404, { error: { message: 'fake 未实现' } })
    return reply(res, 200, llmBody(fake.queue.shift()))
  })
  fakeServer.listen(0, '127.0.0.1')
  await once(fakeServer, 'listening')
  const addr = /** @type {import('node:net').AddressInfo} */ (fakeServer.address())
  return `http://127.0.0.1:${addr.port}`
}

/** @param {string} method @param {string} path @param {unknown} [body] @param {string} [cookie] */
const call = (method, path, body, cookie = cookieA) => app.call(method, path, body, cookie)

const ctxA = () => ({ tenantId: tenantA.tenantId, userId: tenantA.userId, perms: new Set(['*']), requestId: 'test' })

/** @param {string} code */
async function partyByCode(code) {
  return partyStore.byCode(ctxA(), code)
}

test.before(async () => {
  try {
    await connect()
    dbUp = true
  } catch (err) {
    console.log(`跳过：数据库不可用（${/** @type {Error} */ (err).message}）`)
    return
  }

  fakeBase = await startFake()
  app = await makeApp()
  tenantA = await createTenant({ requestId: 'test', userId: null }, { slug: slugA, name: '甲 AI', email: ownerA, password })
  tenantB = await createTenant({ requestId: 'test', userId: null }, { slug: slugB, name: '乙 AI', email: ownerB, password })
  cookieA = await app.login(ownerA, password)
  cookieB = await app.login(ownerB, password)

  // AI 草稿复用审批引擎：先给 doc_type=ai_draft 配一条一级流程
  const flow = await call('POST', `/t/${slugA}/api/approval/flows`, {
    code: `AIFLOW_${run}`.toUpperCase(),
    name: 'AI 草稿审批',
    docType: 'ai_draft',
    enabled: true,
    steps: [{ no: 1, approver_type: 'role', approver_ref: 'owner', mode: 'any' }],
  })
  assert.equal(flow.status, 201)

  const saved = await call('PUT', `/t/${slugA}/api/ai/settings`, {
    baseUrl: `${fakeBase}/v1`,
    apiKey: API_KEY,
    model: 'fake-model',
    enabled: true,
    maxTokens: 512,
    timeoutMs: 5000,
    monthlyTokenLimit: 100000,
  })
  assert.equal(saved.status, 200)
})

test.after(async () => {
  fakeServer?.close()
  await app?.close()
  await close()
})

test('工具契约：write 只有 draft()，结构上没有 run；read 才可执行', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const writeTool = getTool('create_party')
  const readTool = getTool('read_party_list')
  assert.ok(writeTool)
  assert.ok(readTool)
  assert.equal(writeTool.level, 'write')
  assert.equal('run' in writeTool, false, 'write 工具绝不能有 run —— 执行通道不存在')
  assert.equal(typeof writeTool.draft, 'function')
  assert.equal(readTool.level, 'read')
  assert.equal('draft' in readTool, false)

  // 注册时硬拒绝：即使有人想偷偷加执行通道也加不进去
  assert.throws(
    () => registerTool({ name: 'evil_write', level: 'write', perm: 'party:create', schema: {}, run: async () => 1 }),
    /禁止声明 run/,
  )

  // read 通道正常：直接读 svc/party.listParties
  const list = await callRead('read_party_list', { limit: 5 }, ctxA())
  assert.ok(Array.isArray(list.items))
})

test('chat：假 LLM 返回 tool_calls → draft(pending) + 审批实例', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  fake.requests.length = 0
  fake.queue = [{ tool: 'create_party', args: { code: codeA, name: 'AI 客户甲', partyType: 'customer', contactName: '李四', phone: '13900000001' } }]

  const res = await call('POST', `/t/${slugA}/api/ai/chat`, {
    messages: [{ role: 'user', content: '给甲客户建个档' }],
  })
  assert.equal(res.status, 201)
  const body = await jsonOf(res)
  draftId = body.draft.id
  assert.ok(draftId)
  assert.equal(body.draft.status, 'pending')
  assert.equal(body.draft.toolName, 'create_party')
  assert.ok(body.approval?.id, '必须复用审批引擎创建实例')
  assert.ok(body.diff.some((/** @type {any} */ f) => f.field === 'code' && f.after === codeA))

  // 请求体确实带了 tools，且密钥只在 authorization 头里
  const sent = fake.requests.at(-1)
  assert.equal(sent.path, '/v1/chat/completions')
  assert.equal(sent.authorization, `Bearer ${API_KEY}`)
  assert.ok(sent.body.tools.some((/** @type {any} */ x) => x.function.name === 'create_party'))
  assert.equal(sent.body.stream, false)

  const row = await one(ctxA(), `SELECT status, tool_name FROM ai_draft WHERE $t AND id = $1`, [draftId])
  assert.equal(row.status, 'pending')
  assert.equal(row.tool_name, 'create_party')
  const inst = await one(ctxA(), `SELECT doc_type, doc_id, status FROM approval_instance WHERE $t AND doc_id = $1`, [draftId])
  assert.equal(inst.doc_type, 'AI_DRAFT')
  assert.equal(inst.status, 'pending')
  assert.ok(await one(ctxA(), `SELECT id FROM ai_trace WHERE $t AND draft_id = $1`, [draftId]))
})

test('approve → apply：真的建出客户，applied_ref 有值', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const approved = await call('POST', `/t/${slugA}/api/ai/drafts/${draftId}/approve`)
  assert.equal(approved.status, 200)
  assert.equal((await jsonOf(approved)).status, 'approved')

  const applied = await call('POST', `/t/${slugA}/api/ai/drafts/${draftId}/apply`)
  assert.equal(applied.status, 200)
  const body = await jsonOf(applied)
  assert.equal(body.draft.status, 'applied')
  assert.equal(body.draft.appliedRefType, 'party')
  assert.ok(body.draft.appliedRefId)
  assert.equal(body.idempotent, false)

  const party = await partySvc.getParty(ctxA(), body.draft.appliedRefId)
  assert.equal(party.code, codeA)
  assert.equal(party.name, 'AI 客户甲')

  const auditRow = await one(
    ctxA(),
    `SELECT action FROM audit_log WHERE $t AND module = 'ai' AND ref_id = $1 AND action = 'apply'`,
    [draftId],
  )
  assert.ok(auditRow, '落库必须写 ai 审计')
})

test('reject：草稿被驳回，apply 返回 409', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  fake.queue = [{ tool: 'create_party', args: { code: codeB, name: 'AI 客户乙', partyType: 'customer' } }]
  const chat = await call('POST', `/t/${slugA}/api/ai/chat`, { messages: [{ role: 'user', content: '再建一个' }] })
  assert.equal(chat.status, 201)
  const draft = (await jsonOf(chat)).draft

  const rejected = await call('POST', `/t/${slugA}/api/ai/drafts/${draft.id}/reject`, { reason: '联系人不完整' })
  assert.equal(rejected.status, 200)
  assert.equal((await jsonOf(rejected)).status, 'rejected')

  const applied = await call('POST', `/t/${slugA}/api/ai/drafts/${draft.id}/apply`)
  assert.equal(applied.status, 409)
  assert.ok(await one(ctxA(), `SELECT id FROM ai_draft WHERE $t AND id = $1 AND status = 'rejected'`, [draft.id]))
  assert.equal(await partyByCode(codeB), null, '驳回的草稿不能落库')
})

test('重复 apply 幂等：第二次不新建客户', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const before = await partyByCode(codeA)
  assert.ok(before)

  const again = await call('POST', `/t/${slugA}/api/ai/drafts/${draftId}/apply`)
  assert.equal(again.status, 200)
  const body = await jsonOf(again)
  assert.equal(body.idempotent, true)
  assert.equal(body.draft.appliedRefId, before.id)

  const rows = await q(ctxA(), `SELECT id FROM party WHERE $t AND code = $1`, [codeA])
  assert.equal(rows.length, 1, '同一 draft 只能落一单')
})

test('apply 时 payload 失效 → failed + 可读 error；修好后可重试', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  fake.queue = [{ tool: 'create_party', args: { code: codeF, name: 'AI 客户丙', partyType: 'customer' } }]
  const chat = await call('POST', `/t/${slugA}/api/ai/chat`, { messages: [{ role: 'user', content: '第三个' }] })
  assert.equal(chat.status, 201)
  const draft = (await jsonOf(chat)).draft

  // 草稿躺着的期间，编码被别人占了
  const occupied = await call('POST', `/t/${slugA}/api/parties`, {
    code: codeF,
    name: '手工占号',
    partyType: 'customer',
  })
  assert.equal(occupied.status, 201)
  const occupiedId = (await jsonOf(occupied)).id

  assert.equal((await call('POST', `/t/${slugA}/api/ai/drafts/${draft.id}/approve`)).status, 200)
  const failed = await call('POST', `/t/${slugA}/api/ai/drafts/${draft.id}/apply`)
  assert.equal(failed.status, 409)
  const err = await jsonOf(failed)
  assert.match(err.error.message, /落库失败/)
  assert.match(err.error.message, new RegExp(codeF))
  assert.equal(err.error.details.status, 'failed')

  const row = await one(ctxA(), `SELECT status, error FROM ai_draft WHERE $t AND id = $1`, [draft.id])
  assert.equal(row.status, 'failed')
  assert.match(row.error, /已存在/)

  // 修复环境（释放编码）后从 failed 重试 → 成功
  assert.equal((await call('DELETE', `/t/${slugA}/api/parties/${occupiedId}`)).status, 200)
  const retried = await call('POST', `/t/${slugA}/api/ai/drafts/${draft.id}/apply`)
  assert.equal(retried.status, 200)
  const retriedBody = await jsonOf(retried)
  assert.equal(retriedBody.draft.status, 'applied')
  assert.equal((await partyByCode(codeF))?.id, retriedBody.draft.appliedRefId)
})

test('离线降级与配额：关闭/无 key → 503，超配额 → 429，原因明确', async (t) => {
  if (!dbUp) return t.skip('需要数据库')

  let put = await call('PUT', `/t/${slugA}/api/ai/settings`, { enabled: false })
  assert.equal(put.status, 200)
  let chat = await call('POST', `/t/${slugA}/api/ai/chat`, { messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(chat.status, 503)
  let err = await jsonOf(chat)
  assert.match(err.error.message, /关闭|enabled/)

  const drafts = await call('GET', `/t/${slugA}/api/ai/drafts`)
  assert.equal(drafts.status, 503)
  assert.match((await jsonOf(drafts)).error.message, /关闭|enabled/)

  put = await call('PUT', `/t/${slugA}/api/ai/settings`, { enabled: true, apiKey: '' })
  assert.equal(put.status, 200)
  chat = await call('POST', `/t/${slugA}/api/ai/chat`, { messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(chat.status, 503)
  err = await jsonOf(chat)
  assert.match(err.error.message, /api_key/)

  // 恢复密钥与配额，再验证超配额
  const current = await jsonOf(await call('GET', `/t/${slugA}/api/ai/settings`))
  put = await call('PUT', `/t/${slugA}/api/ai/settings`, {
    enabled: true,
    apiKey: API_KEY,
    monthlyTokenLimit: current.usedTokens,
  })
  assert.equal(put.status, 200)
  chat = await call('POST', `/t/${slugA}/api/ai/chat`, { messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(chat.status, 429)
  err = await jsonOf(chat)
  assert.match(err.error.message, /配额/)
  assert.equal(err.error.code, 'ai_quota_exceeded')

  put = await call('PUT', `/t/${slugA}/api/ai/settings`, { monthlyTokenLimit: 0 })
  assert.equal(put.status, 200)
})

test('api_key 加密落库，GET 永不回显明文/密文', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  const res = await call('GET', `/t/${slugA}/api/ai/settings`)
  assert.equal(res.status, 200)
  const raw = await res.text()
  assert.ok(!raw.includes(API_KEY), '明文不能回显')
  assert.ok(!raw.includes('api_key'))
  const body = JSON.parse(raw)
  assert.deepEqual(body.apiKey, { configured: true })
  assert.equal(body.ready, true)

  const row = await one(ctxA(), `SELECT api_key FROM ai_settings WHERE $t`, [])
  assert.equal(typeof row.api_key, 'string')
  assert.notEqual(row.api_key, API_KEY)
  assert.ok(!raw.includes(row.api_key), '密文也不能回显')
  assert.equal(decrypt(row.api_key), API_KEY)
  assert.throws(() => decrypt(`${row.api_key}x`), /解密失败|格式无效/)
})

test('跨租户 404；未知字段 400', async (t) => {
  if (!dbUp) return t.skip('需要数据库')
  assert.equal((await call('GET', `/t/${slugB}/api/ai/drafts/${draftId}`, undefined, cookieB)).status, 404)
  assert.equal(
    (await call('POST', `/t/${slugB}/api/ai/drafts/${draftId}/approve`, undefined, cookieB)).status,
    404,
  )
  assert.equal((await call('POST', `/t/${slugB}/api/ai/drafts/${draftId}/apply`, undefined, cookieB)).status, 404)

  const badChat = await call('POST', `/t/${slugA}/api/ai/chat`, {
    messages: [{ role: 'user', content: 'hi' }],
    tenantId: tenantB.tenantId,
  })
  assert.equal(badChat.status, 400)
  assert.match((await jsonOf(badChat)).error.message, /未知字段/)

  const badSettings = await call('PUT', `/t/${slugA}/api/ai/settings`, { foo: 'bar' })
  assert.equal(badSettings.status, 400)

  const badMsg = await call('POST', `/t/${slugA}/api/ai/chat`, { messages: [{ role: 'user', content: 'hi', x: 1 }] })
  assert.equal(badMsg.status, 400)

  const badReject = await call('POST', `/t/${slugA}/api/ai/drafts/${draftId}/reject`, {})
  assert.equal(badReject.status, 400)
})
