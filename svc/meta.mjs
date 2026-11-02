/**
 * 数据字典（只读）：把散在各 svc 里的枚举常量聚合成一份，供前端渲染下拉。
 *
 * 为什么不做成表：状态类枚举是**状态机的编译期常量**（`PO_TRANSITIONS` 等），
 * 让它们可编辑等于把 DESIGN 明确砍掉的「通用工作流引擎」从后门放进来。
 * 这里只解决"前端硬编码枚举值、加一个值要改三处"的痛点 —— 值只有这一份真源。
 *
 * 显示文案仍然在前端 i18n 里（`core.*` / `f1.*` / `f2.*` …）：两库都要中英双语，
 * 把 200 条标签搬到服务端只会让同一句话存两份。
 */

import { ACCEPTANCE_STATUSES, ACCEPTANCE_TYPES } from './acceptance.mjs'
import { DRAFT_STATUSES } from './ai_draft.mjs'
import { APPROVER_TYPES, DECIDE_ACTIONS } from './approval.mjs'
import { CHANGE_ORDER_STATUSES } from './change_order.mjs'
import { CONTRACT_STATUSES as CONTRACT_STATUSES_M1 } from './contract.mjs'
import { DESIGN_STATUSES } from './design.mjs'
import { ITEM_STATUSES, PRICE_TYPES, WAREHOUSE_STATUSES } from './item.mjs'
import { MATERIAL_ISSUE_STATUSES } from './material_issue.mjs'
import { PARTY_STATUSES, PARTY_TYPES } from './party.mjs'
import { PROJECT_STATUSES } from './project.mjs'
import {
  INVOICE_KINDS,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PO_STATUSES,
  PROGRESS_STATUSES,
  SUB_STATUSES,
} from './purchase.mjs'
import { QUOTATION_STATUSES } from './quotation.mjs'
import { REQUIREMENT_STATUSES } from './requirement.mjs'
import { CONTRACT_STATUSES as SERVICE_CONTRACT_STATUSES } from './service_contract.mjs'
import { SN_STATUSES } from './stock.mjs'
import { TICKET_STATUSES } from './ticket.mjs'
import { TASK_STATUSES } from './work.mjs'

/** 通知渠道与模板语言（前端"通知设置"页要渲染） */
const NOTIFY_CHANNELS = ['inapp', 'email', 'sms', 'dingtalk', 'wecom']
const LANGS = ['zh', 'en']

/** 名称 → 值列表。名字就是前端 `dict('xxx')` 用的键。 */
export const DICTS = {
  partyType: PARTY_TYPES,
  partyStatus: PARTY_STATUSES,

  itemStatus: ITEM_STATUSES,
  warehouseStatus: WAREHOUSE_STATUSES,
  priceType: PRICE_TYPES,
  snStatus: SN_STATUSES,

  opportunityStage: ['new', 'following', 'won', 'lost'],
  projectStatus: PROJECT_STATUSES,
  quotationStatus: QUOTATION_STATUSES,
  contractStatus: CONTRACT_STATUSES_M1,
  requirementStatus: REQUIREMENT_STATUSES,
  designStatus: DESIGN_STATUSES,

  poStatus: PO_STATUSES,
  subStatus: SUB_STATUSES,
  progressStatus: PROGRESS_STATUSES,
  invoiceKind: INVOICE_KINDS,
  paymentKind: PAYMENT_KINDS,
  paymentMethod: PAYMENT_METHODS,

  workTaskStatus: TASK_STATUSES,
  materialIssueStatus: MATERIAL_ISSUE_STATUSES,
  changeOrderStatus: CHANGE_ORDER_STATUSES,
  acceptanceType: ACCEPTANCE_TYPES,
  acceptanceStatus: ACCEPTANCE_STATUSES,

  ticketStatus: TICKET_STATUSES,
  serviceContractStatus: SERVICE_CONTRACT_STATUSES,

  aiDraftStatus: DRAFT_STATUSES,

  approverType: APPROVER_TYPES,
  decideAction: DECIDE_ACTIONS,

  notifyChannel: NOTIFY_CHANNELS,
  lang: LANGS,
}

/** 每个字典都有对应的 i18n key 前缀，前端 `t(prefix + '.' + value)` 就能出标签 */
export const LABEL_PREFIX = {
  partyType: 'type',
  partyStatus: 'status',
  itemStatus: 'status',
  warehouseStatus: 'status',
  poStatus: 'f3.poStatus',
  subStatus: 'f3.subStatus',
  progressStatus: 'f3.progressStatus',
  paymentKind: 'f3.payKind',
  paymentMethod: 'f3.payMethod',
  invoiceKind: 'f3.invoiceKind',
  ticketStatus: 'f4.ticketStatus',
  materialIssueStatus: 'f2.issueStatus',
  changeOrderStatus: 'f2.coStatus',
  acceptanceType: 'f2.atype',
  acceptanceStatus: 'f2.accStatus',
  workTaskStatus: 'f2.taskStatus',
  projectStatus: 'proj.status',
  quotationStatus: 'quo.status',
  contractStatus: 'contract.status',
  opportunityStage: 'oppty.stage',
  serviceContractStatus: 'f4.scStatus',
  aiDraftStatus: 'f4.draftStatus',
  approverType: 'f1.approverType',
  notifyChannel: 'f1.notify.chType',
  lang: 'f1.notify.langName',
}

/** 一次返回全部，前端一个请求搞定 */
export function allDicts() {
  return { dicts: DICTS, labelPrefix: LABEL_PREFIX }
}
