/**
 * 四个列表页共用的格式化小件（日期 / 金额 / 短 id）。
 * 不引任何依赖：Intl 已经够用，语言跟着 i18n.lang 走。
 */
import { computed } from 'vue'
import { i18n } from './i18n.js'
import { state } from './state.js'

const locale = computed(() => (i18n.lang === 'zh' ? 'zh-CN' : 'en-US'))

/** @param {unknown} v */
export const fmtDate = (v) =>
  v
    ? new Date(String(v)).toLocaleDateString(locale.value, { year: 'numeric', month: '2-digit', day: '2-digit' })
    : '—'

/** 月-日 时:分，列表里够用，不占宽度 */
/** @param {unknown} v */
export const fmtDateTime = (v) =>
  v
    ? new Date(String(v)).toLocaleString(locale.value, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'

/** @param {unknown} v */
export const money = (v) =>
  `¥${new Intl.NumberFormat(locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v ?? 0))}`

/** uuid 只露前 8 位；完整值走 title */
/** @param {unknown} v */
export const shortId = (v) => (v ? String(v).slice(0, 8) : '—')

/**
 * 负责人 / 项目经理 → 人名。成员表还没拉到时退回短 id，不会显示空白。
 * @param {unknown} v
 */
export const memberName = (v) => {
  if (!v) return '—'
  const hit = state.members.find((m) => m.userId === v)
  return hit ? hit.displayName : shortId(v)
}

/** ISO / Date → el-date-picker 要的 YYYY-MM-DD */
/** @param {unknown} v */
export const dateInput = (v) => (v ? String(v).slice(0, 10) : '')
