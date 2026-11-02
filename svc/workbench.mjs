import * as store from '../store/workbench.mjs'

/** 工作台首页的展示条数（多取一屏，前端不翻页） */
const RECENT_STAGES = 8
const TODOS = 5

/** COUNT(*) 在 PG 里是 bigint 字符串，MySQL 是数字，统一成数字 */
const n = (/** @type {unknown} */ v) => Number(v ?? 0)

/** money 两库都返回字符串，对外统一两位小数字符串 */
const money = (/** @type {unknown} */ v) => Number(v ?? 0).toFixed(2)

/**
 * 首页聚合：四个计数 + 合同总额 + 最近状态流水 + 待签约清单。
 * 纯只读，不开事务。
 * @param {any} ctx
 */
export async function overview(ctx) {
  const [project, opportunity, quotation, contract, amount, stages, todos] = await Promise.all([
    store.countProjects(ctx),
    store.countOpportunities(ctx),
    store.countQuotations(ctx),
    store.countContracts(ctx),
    store.sumContractAmount(ctx),
    store.recentStages(ctx, RECENT_STAGES),
    store.quotingProjects(ctx, TODOS),
  ])

  return {
    counts: {
      project: n(project?.n),
      opportunity: n(opportunity?.n),
      quotation: n(quotation?.n),
      contract: n(contract?.n),
    },
    contractAmount: money(amount?.amt),
    recentStages: stages.map((r) => ({
      projectId: r.project_id,
      projectCode: r.project_code,
      projectName: r.project_name,
      fromStatus: r.from_status,
      toStatus: r.to_status,
      at: r.at,
    })),
    todos: todos.map((r) => ({
      projectId: r.id,
      code: r.code,
      name: r.name,
      status: r.status,
      updatedAt: r.updated_at,
    })),
  }
}
