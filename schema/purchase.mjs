/**
 * M4 采购与财务域（DESIGN §7.2「采购分包」+「商务财务」）。
 *
 * 边界（有意为之的取舍，写在这里免得后来人猜）：
 * - 金额一律 `money` 物理类型，应用侧按「分」整数算（http/money.mjs），**不用浮点**。
 * - 成本只在「真实发生」时归集：采购=收货（grn_line 落库时写 cost_line），
 *   分包=进度款审批通过。PO/分包审批只生成应付台账，不生成成本，避免重复计算。
 * - 台账（ar_ledger / ap_ledger）是只增不改的流水：正数=债权/债务增加，
 *   负数=收款/付款核销。余额 = SUM(amount)，与手工账本直接对得上。
 * - 不做凭证/总账科目、不做付款审批的银行对接（DESIGN §15 M4 明确）。
 */

export const tables = [
  {
    name: 'purchase_order',
    tenant: true,
    cols: [
      // project_id 可空：允许行政采购不挂项目；挂了才参与项目毛利
      { n: 'project_id', t: 'uuid' },
      { n: 'party_id', t: 'uuid', notNull: true },
      { n: 'code', t: 'code', notNull: true },
      { n: 'amount', t: 'money', notNull: true, default: '0.00' },
      { n: 'status', t: 'code', notNull: true, default: "'draft'" },
      { n: 'note', t: 'text' },
      { n: 'approved_at', t: 'time' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_by', t: 'uuid' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['project_id'], ['party_id'], ['status'], ['created_at', 'id']],
    fk: [
      { cols: ['project_id'], ref: 'project' },
      { cols: ['party_id'], ref: 'party' },
    ],
  },
  {
    name: 'po_line',
    tenant: true,
    cols: [
      { n: 'po_id', t: 'uuid', notNull: true },
      { n: 'line_no', t: 'int', notNull: true },
      { n: 'item_id', t: 'uuid', notNull: true },
      { n: 'qty', t: 'money', notNull: true },
      { n: 'price', t: 'money', notNull: true },
      { n: 'amount', t: 'money', notNull: true },
    ],
    uniq: [['po_id', 'line_no']],
    index: [['po_id'], ['item_id']],
    fk: [
      { cols: ['po_id'], ref: 'purchase_order' },
      { cols: ['item_id'], ref: 'item' },
    ],
  },
  {
    name: 'goods_receipt',
    tenant: true,
    cols: [
      { n: 'po_id', t: 'uuid', notNull: true },
      { n: 'warehouse_id', t: 'uuid', notNull: true },
      { n: 'code', t: 'code', notNull: true },
      // 收货即入账（不做草稿态）：单据一旦存在，库存与流水已经同事务写完
      { n: 'status', t: 'code', notNull: true, default: "'posted'" },
      { n: 'received_at', t: 'time', notNull: true },
      { n: 'note', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'received_by', t: 'uuid' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['po_id'], ['warehouse_id'], ['status'], ['created_at', 'id']],
    fk: [
      { cols: ['po_id'], ref: 'purchase_order' },
      { cols: ['warehouse_id'], ref: 'warehouse' },
    ],
  },
  {
    name: 'grn_line',
    tenant: true,
    cols: [
      { n: 'receipt_id', t: 'uuid', notNull: true },
      { n: 'po_line_id', t: 'uuid', notNull: true },
      { n: 'item_id', t: 'uuid', notNull: true },
      { n: 'qty', t: 'money', notNull: true },
      { n: 'price', t: 'money', notNull: true },
      { n: 'amount', t: 'money', notNull: true },
    ],
    index: [['receipt_id'], ['po_line_id'], ['item_id']],
    fk: [
      { cols: ['receipt_id'], ref: 'goods_receipt' },
      { cols: ['po_line_id'], ref: 'po_line' },
      { cols: ['item_id'], ref: 'item' },
    ],
  },
  {
    name: 'subcontract',
    tenant: true,
    cols: [
      { n: 'project_id', t: 'uuid', notNull: true },
      { n: 'party_id', t: 'uuid', notNull: true },
      { n: 'code', t: 'code', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'amount', t: 'money', notNull: true, default: '0.00' },
      { n: 'status', t: 'code', notNull: true, default: "'draft'" },
      { n: 'note', t: 'text' },
      { n: 'approved_at', t: 'time' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['project_id'], ['party_id'], ['status'], ['created_at', 'id']],
    fk: [
      { cols: ['project_id'], ref: 'project' },
      { cols: ['party_id'], ref: 'party' },
    ],
  },
  {
    name: 'subcontract_progress',
    tenant: true,
    cols: [
      { n: 'subcontract_id', t: 'uuid', notNull: true },
      { n: 'seq', t: 'int', notNull: true },
      // 进度款金额：审批通过后这一步金额进 cost_line
      { n: 'amount', t: 'money', notNull: true },
      { n: 'status', t: 'code', notNull: true, default: "'draft'" },
      { n: 'note', t: 'text' },
      { n: 'approved_at', t: 'time' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['subcontract_id', 'seq']],
    index: [['subcontract_id'], ['status'], ['created_at', 'id']],
    fk: [{ cols: ['subcontract_id'], ref: 'subcontract' }],
  },
  {
    name: 'invoice',
    tenant: true,
    cols: [
      // ar = 销项（对客户开票），ap = 进项（供应商开来）
      { n: 'kind', t: 'code', notNull: true },
      { n: 'party_id', t: 'uuid', notNull: true },
      { n: 'project_id', t: 'uuid' },
      { n: 'contract_id', t: 'uuid' },
      { n: 'po_id', t: 'uuid' },
      { n: 'subcontract_id', t: 'uuid' },
      { n: 'code', t: 'code', notNull: true },
      { n: 'amount', t: 'money', notNull: true },
      { n: 'status', t: 'code', notNull: true, default: "'issued'" },
      { n: 'issued_at', t: 'time', notNull: true },
      { n: 'note', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['kind', 'status'], ['party_id'], ['project_id'], ['contract_id'], ['created_at', 'id']],
    fk: [
      { cols: ['party_id'], ref: 'party' },
      { cols: ['project_id'], ref: 'project' },
      { cols: ['contract_id'], ref: 'contract' },
      { cols: ['po_id'], ref: 'purchase_order' },
      { cols: ['subcontract_id'], ref: 'subcontract' },
    ],
  },
  {
    name: 'ar_ledger',
    tenant: true,
    cols: [
      { n: 'party_id', t: 'uuid', notNull: true },
      { n: 'project_id', t: 'uuid' },
      { n: 'contract_id', t: 'uuid' },
      { n: 'invoice_id', t: 'uuid' },
      // contract | invoice | receipt
      { n: 'entry_type', t: 'code', notNull: true },
      // 正数=新增应收，负数=收款核销；余额 = SUM(amount)
      { n: 'amount', t: 'money', notNull: true },
      { n: 'ref_type', t: 'code' },
      { n: 'ref_id', t: 'uuid' },
      { n: 'note', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    index: [['party_id'], ['project_id'], ['contract_id'], ['at', 'id'], ['created_at', 'id']],
    fk: [
      { cols: ['party_id'], ref: 'party' },
      { cols: ['project_id'], ref: 'project' },
      { cols: ['contract_id'], ref: 'contract' },
      { cols: ['invoice_id'], ref: 'invoice' },
    ],
  },
  {
    name: 'ap_ledger',
    tenant: true,
    cols: [
      { n: 'party_id', t: 'uuid', notNull: true },
      { n: 'project_id', t: 'uuid' },
      { n: 'po_id', t: 'uuid' },
      { n: 'subcontract_id', t: 'uuid' },
      { n: 'invoice_id', t: 'uuid' },
      // purchase_order | subcontract | invoice | payment
      { n: 'entry_type', t: 'code', notNull: true },
      { n: 'amount', t: 'money', notNull: true },
      { n: 'ref_type', t: 'code' },
      { n: 'ref_id', t: 'uuid' },
      { n: 'note', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    index: [['party_id'], ['project_id'], ['po_id'], ['subcontract_id'], ['at', 'id'], ['created_at', 'id']],
    fk: [
      { cols: ['party_id'], ref: 'party' },
      { cols: ['project_id'], ref: 'project' },
      { cols: ['po_id'], ref: 'purchase_order' },
      { cols: ['subcontract_id'], ref: 'subcontract' },
      { cols: ['invoice_id'], ref: 'invoice' },
    ],
  },
  {
    name: 'payment',
    tenant: true,
    cols: [
      // ar = 收款，ap = 付款
      { n: 'kind', t: 'code', notNull: true },
      { n: 'party_id', t: 'uuid', notNull: true },
      { n: 'project_id', t: 'uuid' },
      { n: 'amount', t: 'money', notNull: true },
      { n: 'method', t: 'code', notNull: true, default: "'bank'" },
      { n: 'paid_at', t: 'time', notNull: true },
      { n: 'note', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_by', t: 'uuid' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    index: [['kind', 'party_id'], ['party_id'], ['project_id'], ['paid_at'], ['created_at', 'id']],
    fk: [
      { cols: ['party_id'], ref: 'party' },
      { cols: ['project_id'], ref: 'project' },
    ],
  },
  {
    name: 'cost_line',
    tenant: true,
    cols: [
      { n: 'project_id', t: 'uuid', notNull: true },
      // purchase | subcontract | labor | other
      { n: 'source', t: 'code', notNull: true },
      { n: 'ref_type', t: 'code' },
      { n: 'ref_id', t: 'uuid' },
      { n: 'amount', t: 'money', notNull: true },
      { n: 'note', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    index: [['project_id'], ['source'], ['ref_type', 'ref_id'], ['at', 'id'], ['created_at', 'id']],
    fk: [{ cols: ['project_id'], ref: 'project' }],
  },
]
