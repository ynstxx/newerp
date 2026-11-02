import { reactive } from 'vue'
import zh from './i18n/zh.json'
import en from './i18n/en.json'

const dicts = { zh, en }

export const i18n = reactive({ lang: localStorage.getItem('erp.lang') || 'zh' })

/**
 * 40 行的 t()：点号取值，取不到就把 key 原样返回（缺翻译一眼看得见）。
 * ponytail: 不引 vue-i18n —— 没有复数规则和日期本地化需求
 * @param {string} key
 */
export function t(key) {
  const dict = dicts[i18n.lang] ?? zh
  return key.split('.').reduce((node, part) => (node ? node[part] : undefined), dict) ?? key
}

/**
 * 带占位符的 t()：`tp('dash.greet', { name })` →「早安，张三」。
 * 只做 {name} 这种简单替换，够用；复数/日期规则不引 vue-i18n。
 * @param {string} key
 * @param {Record<string, string | number>} vars
 */
export function tp(key, vars) {
  return t(key).replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}

/** @param {'zh'|'en'} lang */
export function setLang(lang) {
  i18n.lang = lang
  localStorage.setItem('erp.lang', lang)
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
}
