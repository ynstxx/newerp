import { HttpError, errors } from '../http/errors.mjs'

/** 权限串 模块:动作（DESIGN §8）。角色 → 权限点是代码常量，不是表。 */
export const PERM = {
  partyView: 'party:view',
  partyCreate: 'party:create',
  partyUpdate: 'party:update',
  partyDelete: 'party:delete',
  memberView: 'member:view',
  memberManage: 'member:manage',
  // M1 项目主链：每个实体 view/create/update，另加一个终止权
  opportunityView: 'opportunity:view',
  opportunityCreate: 'opportunity:create',
  opportunityUpdate: 'opportunity:update',
  projectView: 'project:view',
  projectCreate: 'project:create',
  projectUpdate: 'project:update',
  projectTerminate: 'project:terminate',
  requirementView: 'requirement:view',
  requirementCreate: 'requirement:create',
  requirementUpdate: 'requirement:update',
  designView: 'design:view',
  designCreate: 'design:create',
  designUpdate: 'design:update',
  quotationView: 'quotation:view',
  quotationCreate: 'quotation:create',
  quotationUpdate: 'quotation:update',
  contractView: 'contract:view',
  contractCreate: 'contract:create',
  contractUpdate: 'contract:update',
}

/** role.code → 权限点。`*` = 全部。M0/M1 只支 owner/member 两个角色。 */
/** @type {Record<string, string[]>} */
export const ROLE_PERMS = {
  owner: ['*'],
  // 普通成员：所有模块的查看/新建/修改，但**不含**配置类与危险动作
  // （*:terminate / *:delete / *:config / *:manage / *:dispatch / *:approve 都不在其中）
  member: ['*:view', '*:create', '*:update'],
}

/** @type {Record<string, string>} */
export const ROLE_SCOPE = { owner: 'all', member: 'own' }

/** @param {string | undefined | null} code */
export function permsOf(code) {
  return new Set(ROLE_PERMS[code ?? ''] ?? [])
}

/**
 * handler 内调用。缺登录 → 401；有登录无权限 → 403（对象存在性已知）
 * @param {any} ctx
 * @param {string} perm
 */
/**
 * 权限串匹配：精确 / `*`（全部）/ `<模块>:*`（该模块任意动作）/ `*:<动作>`（任意模块的该动作）。
 * 两个方向都支持，member 才能用 `*:view` 这种写法，而不是每加一个域就在角色表里补一行。
 */
export function hasPerm(/** @type {Set<string>} */ perms, /** @type {string} */ perm) {
  if (perms.has('*') || perms.has(perm)) return true
  const [mod, action] = perm.split(':')
  return perms.has(`${mod}:*`) || perms.has(`*:${action}`)
}

/** @param {any} ctx @param {string} perm */
export function need(ctx, perm) {
  if (!ctx.userId) throw new HttpError(errors.unauthorized)
  if (!hasPerm(ctx.perms, perm)) throw new HttpError(errors.forbidden, { need: perm })
}

/** @param {any} ctx */
export function needUser(ctx) {
  if (!ctx.userId) throw new HttpError(errors.unauthorized)
}
