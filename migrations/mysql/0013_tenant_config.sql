-- 0013_tenant_config · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 75 · 语句 1 · 2026-11-02T10:26:03.931Z

CREATE TABLE `sys_config` (
  `config_key` varchar(64) NOT NULL,
  `config_value` varchar(64) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  PRIMARY KEY (`tenant_id`, `config_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
