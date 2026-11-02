-- 0014_config_text_and_outbox_idx · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 75 · 语句 2 · 2026-11-02T10:57:14.788Z

ALTER TABLE `sys_config` MODIFY COLUMN `config_value` text NOT NULL;

ALTER TABLE `stock_move` DROP INDEX `idx_stock_move_tenant_id_at`;
