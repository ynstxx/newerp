/**
 * M5 售后域：服务合同 + 工单 + SLA + 派工 + 巡检 + 备件 + 满意度。
 *
 * 边界：
 * - 设备身份只用自由文本 `sn`，**不引用 item_sn**（主数据域并行建设中）。
 * - 备件也用自由文本 item_name，不扣库存；真正扣料属施工/库存域。
 * - 工单状态机在 svc/ticket.mjs，handler 不允许裸改 status。
 */

export const tables = [
  {
    name: 'service_contract',
    tenant: true,
    cols: [
      { n: 'code', t: 'code', notNull: true },
      { n: 'party_id', t: 'uuid', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'start_at', t: 'time' },
      { n: 'end_at', t: 'time' },
      { n: 'sla_level', t: 'code', notNull: true, default: "'P2'" },
      { n: 'response_minutes', t: 'int', notNull: true, default: '60' },
      { n: 'resolve_minutes', t: 'int', notNull: true, default: '480' },
      { n: 'amount', t: 'money', notNull: true, default: '0.00' },
      { n: 'status', t: 'code', notNull: true, default: "'active'" },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['party_id'], ['status'], ['created_at', 'id']],
    fk: [{ cols: ['party_id'], ref: 'party' }],
  },
  {
    name: 'ticket',
    tenant: true,
    cols: [
      { n: 'code', t: 'code', notNull: true },
      { n: 'contract_id', t: 'uuid' },
      { n: 'party_id', t: 'uuid', notNull: true },
      { n: 'title', t: 'code', notNull: true },
      { n: 'content', t: 'text' },
      // 设备序列号是自由文本：M5 不依赖 item_sn，等主数据域合并后可再做映射
      { n: 'sn', t: 'code' },
      { n: 'priority', t: 'code', notNull: true, default: "'normal'" },
      { n: 'status', t: 'code', notNull: true, default: "'待受理'" },
      { n: 'assignee_id', t: 'uuid' },
      { n: 'reported_at', t: 'time', notNull: true },
      { n: 'responded_at', t: 'time' },
      { n: 'resolved_at', t: 'time' },
      { n: 'sla_due_at', t: 'time' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['contract_id'], ['party_id'], ['status'], ['priority'], ['sn'], ['assignee_id'], ['created_at', 'id']],
    fk: [
      { cols: ['contract_id'], ref: 'service_contract' },
      { cols: ['party_id'], ref: 'party' },
    ],
  },
  {
    name: 'ticket_event',
    tenant: true,
    cols: [
      { n: 'ticket_id', t: 'uuid', notNull: true },
      { n: 'actor_id', t: 'uuid' },
      { n: 'action', t: 'code', notNull: true },
      { n: 'comment', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
    ],
    index: [['ticket_id', 'at']],
    fk: [{ cols: ['ticket_id'], ref: 'ticket' }],
  },
  {
    name: 'dispatch',
    tenant: true,
    cols: [
      { n: 'ticket_id', t: 'uuid', notNull: true },
      { n: 'engineer_id', t: 'uuid', notNull: true },
      { n: 'assigned_at', t: 'time', notNull: true },
      { n: 'accepted_at', t: 'time' },
      { n: 'finished_at', t: 'time' },
      { n: 'note', t: 'text' },
    ],
    index: [['ticket_id'], ['engineer_id']],
    fk: [{ cols: ['ticket_id'], ref: 'ticket' }],
  },
  {
    name: 'maintenance_plan',
    tenant: true,
    cols: [
      { n: 'contract_id', t: 'uuid', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'cron_note', t: 'code' },
      { n: 'next_at', t: 'time' },
      { n: 'enabled', t: 'bool', notNull: true, default: 'TRUE' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    index: [['contract_id'], ['next_at'], ['created_at', 'id']],
    fk: [{ cols: ['contract_id'], ref: 'service_contract' }],
  },
  {
    name: 'maintenance_task',
    tenant: true,
    cols: [
      { n: 'plan_id', t: 'uuid', notNull: true },
      { n: 'due_at', t: 'time', notNull: true },
      { n: 'done_at', t: 'time' },
      { n: 'result', t: 'text' },
      { n: 'assignee_id', t: 'uuid' },
    ],
    index: [['plan_id', 'due_at'], ['done_at']],
    fk: [{ cols: ['plan_id'], ref: 'maintenance_plan' }],
  },
  {
    name: 'spare_part_move',
    tenant: true,
    cols: [
      { n: 'ticket_id', t: 'uuid', notNull: true },
      { n: 'item_name', t: 'code', notNull: true },
      { n: 'qty', t: 'money', notNull: true },
      { n: 'dir', t: 'code', notNull: true },
      { n: 'note', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
    ],
    index: [['ticket_id', 'at']],
    fk: [{ cols: ['ticket_id'], ref: 'ticket' }],
  },
  {
    name: 'satisfaction',
    tenant: true,
    cols: [
      { n: 'ticket_id', t: 'uuid', notNull: true },
      { n: 'score', t: 'int', notNull: true },
      { n: 'comment', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
    ],
    index: [['ticket_id', 'at']],
    fk: [{ cols: ['ticket_id'], ref: 'ticket' }],
  },
]
