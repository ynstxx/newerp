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
