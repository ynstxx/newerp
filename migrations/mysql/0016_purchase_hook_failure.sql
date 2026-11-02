-- 0016_purchase_hook_failure · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 75 · 语句 3 · 2026-11-02T11:25:23.734Z

ALTER TABLE `purchase_order` ADD COLUMN `error_message` text;

ALTER TABLE `subcontract` ADD COLUMN `error_message` text;

ALTER TABLE `subcontract_progress` ADD COLUMN `error_message` text;
