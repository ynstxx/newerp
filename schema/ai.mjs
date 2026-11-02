/**
 * AI 层（DESIGN §12）：租户级 LLM 配置 + 草稿 + 调用轨迹。
 *
 * 三张表都带 tenant_id：配置、草稿、轨迹按租户隔离。
 * ai_settings.api_key 只存 aes-256-gcm 密文（svc/ai_crypto.mjs），永不回显。
 * ai_draft 是唯一的落库入口：AI 只能写这张表，真正的业务表由人工审后 apply 写入。
 */

export const tables = [
  {
    name: 'ai_settings',
    tenant: true,
    cols: [
      // 兼容任意 OpenAI 协议端点（云 API / Ollama / vLLM），URL 可能超过 code 的 64 字符
      { n: 'base_url', t: 'text' },
      // base64(iv|tag|ciphertext)，永不明文落库、永不回显
      { n: 'api_key', t: 'text' },
      { n: 'model', t: 'code' },
      { n: 'enabled', t: 'bool', notNull: true, default: 'false' },
      { n: 'max_tokens', t: 'int', notNull: true, default: '1024' },
      { n: 'timeout_ms', t: 'int', notNull: true, default: '15000' },
      // 0 = 不限；used_tokens 由 svc 在每次调用后累加
      { n: 'monthly_token_limit', t: 'int', notNull: true, default: '0' },
      { n: 'used_tokens', t: 'int', notNull: true, default: '0' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    index: [['enabled']],
  },
  {
    name: 'ai_draft',
    tenant: true,
    cols: [
      { n: 'tool_name', t: 'code', notNull: true },
      // 工具 draft() 产出的规范 payload；整存整取，不做 JSON 路径查询
      { n: 'payload', t: 'json', notNull: true },
      // 字段级 diff + 摘要，人审时直接看这个
      { n: 'preview', t: 'json', notNull: true },
      // draft|pending|approved|applied|rejected|failed
      { n: 'status', t: 'code', notNull: true },
      { n: 'submitter_id', t: 'uuid', notNull: true },
      // 落库后的业务引用，如 party / <uuid>；同一 draft 重复 apply 靠它返回原单
      { n: 'applied_ref_type', t: 'code' },
      { n: 'applied_ref_id', t: 'uuid' },
      { n: 'error', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    index: [['status'], ['tool_name'], ['created_at', 'id']],
  },
  {
    name: 'ai_trace',
    tenant: true,
    cols: [
      // 读工具轮次也可以没有草稿
      { n: 'draft_id', t: 'uuid' },
      { n: 'model', t: 'code' },
      { n: 'prompt_tokens', t: 'int', notNull: true, default: '0' },
      { n: 'completion_tokens', t: 'int', notNull: true, default: '0' },
      // 供应商价格各不相同，先记 0；需要成本核算时在 settings 增加单价再算
      { n: 'cost_micros', t: 'int', notNull: true, default: '0' },
      { n: 'duration_ms', t: 'int', notNull: true, default: '0' },
      // 原始 tool_calls 数组（整存整取）
      { n: 'tool_calls', t: 'json' },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    index: [['created_at', 'id'], ['draft_id']],
  },
]
