import { reactive } from 'vue'

/**
 * 字典按域拆文件，构建时自动合并：
 *   i18n/<域>.zh.json  +  i18n/<域>.en.json
 * 这样新增一个业务域只需要加两个文件，不用改这个文件、也不会和别人冲突。
 * 缺 key 时 t() 原样返回 key，一眼看得出漏翻。
 */

/** @param {Record<string, any>} target @param {Record<string, any>} src */
function merge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = merge(target[k] ?? {}, v)
    } else {
      target[k] = v
    }
  }
  return target
}

/** @type {Record<string, Record<string, any>>} */
const dicts = { zh: {}, en: {} }
for (const [path, mod] of Object.entries(import.meta.glob('./i18n/*.zh.json', { eager: true }))) {
  void path
  merge(dicts.zh, /** @type {any} */ (mod).default)
}
for (const [path, mod] of Object.entries(import.meta.glob('./i18n/*.en.json', { eager: true }))) {
  void path
  merge(dicts.en, /** @type {any} */ (mod).default)
}

export const i18n = reactive({ lang: localStorage.getItem('erp.lang') || 'zh' })

/**
 * 40 行的 t()：点号取值，取不到就把 key 原样返回。
 * ponytail: 不引 vue-i18n —— 没有复数规则和日期本地化需求
 * @param {string} key
 */
export function t(key) {
  const dict = dicts[i18n.lang] ?? dicts.zh
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
