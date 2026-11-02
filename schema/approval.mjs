/**
 * 审批引擎（DESIGN §9）：有序多级 + 金额档，**不做**并行分支/会签网关/条件表达式。
 *
 * `flow_snapshot` 提交时整条链快照进 instance —— 流程定义后改不影响在途单据；
 * steps / snapshot 都是 JSON 整存整取（禁 JSON 路径查询，DESIGN §6.2）。
 *
 * org_dept / org_dept_member 只为审批人解析 `manager` 而建：
 *   org_dept.manager_user_id = 该部门负责人，沿 parent_id 向上即「直属上级」；
 *   org_dept_member 是人与部门的归属（org_membership 是平台域的表，本域不能改它）。
 * 主数据的组织架构模块落地后，这两张表应改由它写入，本域只读。
 */

export const tables = [
  {
    name: 'org_dept',
    tenant: true,
    cols: [
      { n: 'parent_id', t: 'uuid' },
      { n: 'name', t: 'code', notNull: true },
      // 物化路径 '/root/sales/east'，只用于稳定排序与展示（不做前缀查询）
      { n: 'path', t: 'text', notNull: true },
      { n: 'manager_user_id', t: 'uuid' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
      { n: 'version', t: 'int', notNull: true },
    ],
    index: [['parent_id'], ['manager_user_id']],
    fk: [{ cols: ['parent_id'], ref: 'org_dept' }],
  },
  {
    name: 'org_dept_member',
    tenant: true,
    cols: [
      { n: 'dept_id', t: 'uuid', notNull: true },
      { n: 'user_id', t: 'uuid', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
      // 映射表只插删不更新；version 留着与其它租户表同形状（契约要求）
      { n: 'version', t: 'int', notNull: true, default: '0' },
    ],
    uniq: [['dept_id', 'user_id']],
    index: [['user_id']],
    fk: [{ cols: ['dept_id'], ref: 'org_dept' }],
  },
  {
    name: 'approval_flow',
    tenant: true,
    cols: [
      { n: 'code', t: 'code', notNull: true },
      { n: 'name', t: 'code', notNull: true },
      { n: 'doc_type', t: 'code', notNull: true },
      { n: 'enabled', t: 'bool', notNull: true, default: 'true' },
      // [{no, approver_type, approver_ref, mode, min_amount, max_amount}] —— 整存整取
      { n: 'steps', t: 'json', notNull: true },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
      { n: 'version', t: 'int', notNull: true },
    ],
    uniq: [['code']],
    index: [['doc_type', 'enabled'], ['created_at', 'id']],
  },
  {
    name: 'approval_instance',
    tenant: true,
    cols: [
      { n: 'flow_id', t: 'uuid', notNull: true },
      { n: 'doc_type', t: 'code', notNull: true },
      { n: 'doc_id', t: 'uuid', notNull: true },
      { n: 'status', t: 'code', notNull: true },
      { n: 'current_step', t: 'int', notNull: true },
      { n: 'amount', t: 'money', notNull: true },
      // 提交时的审批链快照：{flowId, flowCode, steps:[...]} —— 只整读，不做路径查询
      { n: 'flow_snapshot', t: 'json', notNull: true },
      { n: 'submitter_id', t: 'uuid', notNull: true },
      { n: 'submitted_at', t: 'time', notNull: true },
      { n: 'finished_at', t: 'time' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'updated_at', t: 'time', notNull: true },
      { n: 'version', t: 'int', notNull: true },
    ],
    index: [['doc_type', 'doc_id'], ['status'], ['submitter_id'], ['created_at', 'id']],
    fk: [{ cols: ['flow_id'], ref: 'approval_flow' }],
  },
  {
    name: 'approval_task',
    tenant: true,
    cols: [
      { n: 'instance_id', t: 'uuid', notNull: true },
      { n: 'step_no', t: 'int', notNull: true },
      // role 型 + mode='any' 时为 NULL：该角色任一人可认领（decide 时落具体人）
      { n: 'approver_user_id', t: 'uuid' },
      { n: 'status', t: 'code', notNull: true },
      { n: 'acted_at', t: 'time' },
      { n: 'comment', t: 'text' },
      { n: 'remind_count', t: 'int', notNull: true, default: '0' },
      { n: 'created_at', t: 'time', notNull: true },
      { n: 'version', t: 'int', notNull: true },
    ],
    // MySQL 唯一约束视 NULL 为互不相等：role 占位行每级只建一条，靠 svc 保证
    uniq: [['instance_id', 'step_no', 'approver_user_id']],
    index: [['approver_user_id', 'status'], ['instance_id', 'step_no'], ['status']],
    fk: [{ cols: ['instance_id'], ref: 'approval_instance' }],
  },
  {
    name: 'approval_event',
    tenant: true,
    cols: [
      { n: 'instance_id', t: 'uuid', notNull: true },
      { n: 'actor_id', t: 'uuid' },
      { n: 'action', t: 'code', notNull: true },
      { n: 'comment', t: 'text' },
      { n: 'at', t: 'time', notNull: true },
    ],
    index: [['instance_id', 'at']],
    fk: [{ cols: ['instance_id'], ref: 'approval_instance' }],
  },
]
