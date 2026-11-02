import { reactive } from 'vue'
import { setTenant } from './api.js'

/** 全局状态就这么多，不引 pinia。 */
export const state = reactive({
  /** @type {{ id: string, email: string, displayName: string } | null} */
  user: null,
  /** @type {{ slug: string, name: string, role: string }[]} */
  tenants: [],
  /** @type {{ id: string, slug: string, name: string } | null} */
  tenant: null,
  /** @type {string[]} */
  perms: [],
  /** @type {{ userId: string, displayName: string }[]} 本公司成员，用于把负责人 uuid 显示成人名 */
  members: [],
  /** @type {Record<string, string[]>} 服务端下发的枚举值（数据字典） */
  dicts: {},
  /** @type {Record<string, string>} 每个字典对应的 i18n key 前缀 */
  dictPrefix: {},
})

/** @param {string} slug */
export function pickTenant(slug) {
  const found = state.tenants.find((t) => t.slug === slug) ?? null
  state.tenant = found
  setTenant(slug)
  localStorage.setItem('erp.tenant', slug)
}

export function forgetTenant() {
  state.tenant = null
  setTenant('')
  localStorage.removeItem('erp.tenant')
}

export function logout() {
  state.user = null
  state.tenants = []
  state.perms = []
  forgetTenant()
}

export function rememberedTenant() {
  return localStorage.getItem('erp.tenant') ?? ''
}

/**
 * 取一个字典的值列表。拿不到时返回空数组 —— 下拉为空比崩掉好，但会立刻看得出来。
 * @param {string} name
 * @returns {string[]}
 */
export function dict(name) {
  return state.dicts[name] ?? []
}

/**
 * 字典值的 i18n key，前端 `t(dictKey('partyType', 'customer'))` → `type.customer`
 * @param {string} name @param {string} value
 */
export function dictKey(name, value) {
  const prefix = state.dictPrefix[name]
  return prefix ? `${prefix}.${value}` : value
}
