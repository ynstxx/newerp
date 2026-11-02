import { exec } from '../db/index.mjs'

// 租户表：只插不改不删（DESIGN §8）

/**
 * @param {any} ctx
 * @param {{ id: string, module: string, action: string, whoId: string | null, refType: string | null, refId: string | null, before: unknown, after: unknown, traceId: string, at: Date }} a
 */
export const insert = (ctx, a) =>
  exec(
    ctx,
    `INSERT INTO audit_log (tenant_id, id, who_id, module, action, ref_type, ref_id, before_json, after_json, trace_id, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      ctx.tenantId,
      a.id,
      a.whoId,
      a.module,
      a.action,
      a.refType,
      a.refId,
      a.before === undefined ? null : JSON.stringify(a.before),
      a.after === undefined ? null : JSON.stringify(a.after),
      a.traceId,
      a.at,
    ],
  )
