/**
 * M3 施工域：计划/任务/进度/领料/变更签证/验收/工时/现场记录（DESIGN §7.2）。
 *
 * 边界：
 * - 领料出库**只调** svc/stock.applyMove，本域不碰 stock_bin / stock_move；
 *   出库失败由审批钩子把 material_issue 落 failed 并写 error_message（不吞错误）。
 * - 变更签证通过审批后累加 project.contract_amt（写 project 的 SQL 放在 store/work.mjs，
 *   避免各域都去改 store/project.mjs）。
 * - 验收通过推项目状态时调 svc/project.advanceProject，状态机仍只有一份。
 * - 领料按数量出库，不带 SN（SN 核销属 M5/后续，见 docs/work-DESIGN.md）。
 *
 * 日志类表（progress_log）带 version 列只是为了与其它租户表同形状（契约要求），只插不改。
 */

export const tables = [
  {
    name: 'work_plan',
    tenant: true,
    cols: [
      { n: 'project_id', t: 'uuid', notNull: true },
      { n: 'code', t: 'code', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'plan_start', t: 'time' },
      { n: 'plan_end', t: 'time' },
      { n: 'note', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['project_id'], ['created_at', 'id']],
    fk: [{ cols: ['project_id'], ref: 'project' }],
  },
  {
    name: 'work_task',
    tenant: true,
    cols: [
      { n: 'plan_id', t: 'uuid', notNull: true },
      // 冗余 project_id：按项目查任务/做权限过滤时不必 JOIN work_plan
      { n: 'project_id', t: 'uuid', notNull: true },
      { n: 'code', t: 'code', notNull: true },
      { n: 'title', t: 'code', notNull: true },
      { n: 'assignee_id', t: 'uuid' },
      { n: 'status', t: 'code', notNull: true, default: "'todo'" },
      { n: 'progress', t: 'int', notNull: true, default: '0' },
      { n: 'plan_start', t: 'time' },
      { n: 'plan_end', t: 'time' },
      { n: 'note', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['plan_id'], ['project_id', 'status'], ['assignee_id'], ['created_at', 'id']],
    fk: [
      { cols: ['plan_id'], ref: 'work_plan' },
      { cols: ['project_id'], ref: 'project' },
    ],
  },
  {
    name: 'progress_log',
    tenant: true,
    cols: [
      { n: 'task_id', t: 'uuid', notNull: true },
      { n: 'project_id', t: 'uuid', notNull: true },
      { n: 'reporter_id', t: 'uuid' },
      { n: 'progress', t: 'int', notNull: true },
      { n: 'content', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
      { n: 'version', t: 'int', notNull: true, default: '0' },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    index: [['task_id', 'at'], ['project_id', 'at'], ['created_at', 'id']],
    fk: [
      { cols: ['task_id'], ref: 'work_task' },
      { cols: ['project_id'], ref: 'project' },
    ],
  },
  {
    name: 'material_issue',
    tenant: true,
    cols: [
      { n: 'project_id', t: 'uuid', notNull: true },
      { n: 'code', t: 'code', notNull: true },
      { n: 'warehouse_id', t: 'uuid', notNull: true },
      { n: 'applicant_id', t: 'uuid' },
      // 审批金额档用：不给就按明细 qty×unit_cost 现算
      { n: 'amount', t: 'money', notNull: true, default: '0.00' },
      { n: 'status', t: 'code', notNull: true, default: "'draft'" },
      // 审批实例 id：出库失败时前端靠它去看审批单/事件
      { n: 'approval_instance_id', t: 'uuid' },
      // 出库失败原因（库存不足等），审批通过后 hook 里写入
      { n: 'error_message', t: 'text' },
      { n: 'note', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['project_id'], ['warehouse_id'], ['status'], ['created_at', 'id']],
    fk: [
      { cols: ['project_id'], ref: 'project' },
      { cols: ['warehouse_id'], ref: 'warehouse' },
    ],
  },
  {
    name: 'material_issue_line',
    tenant: true,
    cols: [
      { n: 'issue_id', t: 'uuid', notNull: true },
      { n: 'item_id', t: 'uuid', notNull: true },
      { n: 'qty', t: 'money', notNull: true },
      { n: 'unit_cost', t: 'money' },
      { n: 'note', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '0' },
      { n: 'created_at', t: 'time', notNull: true },
    ],
    index: [['issue_id'], ['item_id'], ['issue_id', 'created_at']],
    fk: [
      { cols: ['issue_id'], ref: 'material_issue' },
      { cols: ['item_id'], ref: 'item' },
    ],
  },
  {
    name: 'change_order',
    tenant: true,
    cols: [
      { n: 'project_id', t: 'uuid', notNull: true },
      { n: 'code', t: 'code', notNull: true },
      { n: 'title', t: 'code', notNull: true },
      // 增量：正数加账、负数减账（金额按分算，见 http/money.mjs）
      { n: 'amount', t: 'money', notNull: true },
      { n: 'reason', t: 'text' },
      { n: 'status', t: 'code', notNull: true, default: "'draft'" },
      { n: 'approval_instance_id', t: 'uuid' },
      { n: 'applied_at', t: 'time' },
      { n: 'error_message', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['project_id'], ['status'], ['created_at', 'id']],
    fk: [{ cols: ['project_id'], ref: 'project' }],
  },
  {
    name: 'acceptance',
    tenant: true,
    cols: [
      { n: 'project_id', t: 'uuid', notNull: true },
      { n: 'code', t: 'code', notNull: true },
      // hidden = 隐蔽工程验收，overall = 整体验收
      { n: 'type', t: 'code', notNull: true },
      { n: 'status', t: 'code', notNull: true, default: "'draft'" },
      // [{name, result: pass|fail|na, note}] —— 整存整取，不做 JSON 路径查询
      { n: 'items', t: 'json', notNull: true },
      { n: 'conclusion', t: 'text' },
      { n: 'accepted_by', t: 'uuid' },
      { n: 'accepted_at', t: 'time' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    uniq: [['code']],
    index: [['project_id'], ['type', 'status'], ['created_at', 'id']],
    fk: [{ cols: ['project_id'], ref: 'project' }],
  },
  {
    name: 'labor_hour',
    tenant: true,
    cols: [
      { n: 'project_id', t: 'uuid', notNull: true },
      { n: 'task_id', t: 'uuid' },
      { n: 'user_id', t: 'uuid', notNull: true },
      { n: 'work_date', t: 'time', notNull: true },
      { n: 'hours', t: 'money', notNull: true },
      { n: 'note', t: 'text' },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    index: [['project_id', 'work_date'], ['user_id'], ['task_id'], ['created_at', 'id']],
    fk: [
      { cols: ['project_id'], ref: 'project' },
      { cols: ['task_id'], ref: 'work_task' },
    ],
  },
  {
    name: 'site_record',
    tenant: true,
    cols: [
      { n: 'project_id', t: 'uuid', notNull: true },
      { n: 'author_id', t: 'uuid' },
      { n: 'recorded_at', t: 'time', notNull: true },
      { n: 'weather', t: 'code' },
      { n: 'content', t: 'text', notNull: true },
      { n: 'version', t: 'int', notNull: true, default: '1' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
    ],
    index: [['project_id', 'recorded_at'], ['created_at', 'id']],
    fk: [{ cols: ['project_id'], ref: 'project' }],
  },
]
