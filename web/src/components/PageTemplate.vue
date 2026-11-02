<script setup>
/**
 * 列表 / 表单页的统一骨架。五个位置固定，业务只往槽里塞东西：
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ [搜索 / 筛选]                    [功能按钮]  │  左上 / 右上
 *   ├──────────────────────────────────────────────┤
 *   │                                              │
 *   │            列表框 或 表单（默认槽）          │  中间
 *   │                                              │
 *   ├──────────────────────────────────────────────┤
 *   │ 提示文本                            [分页]   │  左下 / 右下
 *   └──────────────────────────────────────────────┘
 *
 * 约定：页面自己不写外层卡片、不写工具栏布局、不写底部对齐 —— 都在这一个文件里。
 * 槽全部可选：没有 #hint / #pager 时底部不渲染，表单页就不会多出一条空横线。
 */
defineProps({
  /** 是否给中间区加内边距（表格想通栏贴边就传 false） */
  padded: { type: Boolean, default: false },
})
</script>

<template>
  <section class="page erp-card">
    <header v-if="$slots.search || $slots.actions" class="page-toolbar">
      <div class="page-search">
        <slot name="search" />
      </div>
      <div class="page-actions">
        <slot name="actions" />
      </div>
    </header>

    <div class="page-body" :class="{ padded }">
      <slot />
    </div>

    <footer v-if="$slots.hint || $slots.pager" class="page-footer">
      <div class="page-hint erp-weak">
        <slot name="hint" />
      </div>
      <div class="page-pager">
        <slot name="pager" />
      </div>
    </footer>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 左上搜索 / 右上按钮 */
.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
  flex-wrap: wrap;
  padding: var(--erp-pad-card) var(--erp-pad-card) 0;
}
.page-search,
.page-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
}
.page-actions {
  margin-left: auto;
}

/* 中间：列表框 / 表单 */
.page-body {
  padding: var(--erp-pad-card) 0 0;
  min-height: 0;
}
.page-body.padded {
  padding: var(--erp-pad-card);
}

/* 左下提示 / 右下分页 */
.page-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 var(--erp-pad-card);
  padding: 14px 0 var(--erp-pad-card);
  border-top: 1px solid var(--erp-border);
  margin-top: var(--erp-gap);
}
.page-hint {
  min-width: 0;
}
.page-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
</style>
