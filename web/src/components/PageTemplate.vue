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
// 不用传参：三块区域的留白都在下面 CSS 里定义，
// 中间区是否补底部内边距由 :last-child 自动判断（有底栏时不补）。

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

    <div class="page-body">
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
  --page-pad: var(--erp-pad-card); /* 左右 24px */
  --page-pad-y: 20px; /* 上下 20px：略小于左右，视觉上才不像"上下留太多" */

  display: flex;
  flex-direction: column;
  min-height: 0;
  /* .erp-card 自己带 padding，这里清零；留白统一由下面三块自己管 */
  padding: 0;
}

/* 左上搜索 / 右上按钮 */
.page-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px 16px;
  flex-wrap: wrap;
  padding: var(--page-pad-y) var(--page-pad) 0;
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
  padding: var(--page-pad-y) var(--page-pad) 0;
  min-height: 0;
}
/* 没有底栏时（表单页），自己补上底部留白 */
.page-body:last-child {
  padding-bottom: var(--page-pad-y);
}

/* 左下提示 / 右下分页 */
.page-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin: 0 var(--page-pad);
  padding: 12px 0 var(--page-pad-y);
  border-top: 1px solid var(--erp-border);
  margin-top: var(--page-pad-y);
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
