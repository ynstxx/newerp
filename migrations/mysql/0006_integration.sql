-- 0006_integration · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 40 · 语句 8 · 2026-11-02T08:21:20.960Z

CREATE TABLE `integration_conn` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `provider` varchar(64) NOT NULL,
  `corp_id` varchar(64),
  `agent_id` varchar(64),
  `secrets` json,
  `enabled` tinyint(1) NOT NULL DEFAULT false,
  `last_sync_at` datetime(3),
  `version` int NOT NULL DEFAULT 1,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_integration_conn_tenant_id_provider` UNIQUE (`tenant_id`, `provider`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_integration_conn_tenant_id_enabled` ON `integration_conn` (`tenant_id`, `enabled`);

CREATE TABLE `integration_map` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `provider` varchar(64) NOT NULL,
  `external_type` varchar(64) NOT NULL,
  `external_id` varchar(64) NOT NULL,
  `local_id` varchar(64) NOT NULL,
  `synced_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_integration_map_tenant_id_provider_external_type_external` UNIQUE (`tenant_id`, `provider`, `external_type`, `external_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_integration_map_tenant_id_provider_external_type_local_i` ON `integration_map` (`tenant_id`, `provider`, `external_type`, `local_id`);

CREATE INDEX `idx_integration_map_tenant_id_provider_external_type` ON `integration_map` (`tenant_id`, `provider`, `external_type`);

CREATE TABLE `integration_sync_log` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `provider` varchar(64) NOT NULL,
  `action` varchar(64) NOT NULL,
  `counts` json,
  `error` text,
  `at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_integration_sync_log_tenant_id_provider_at` ON `integration_sync_log` (`tenant_id`, `provider`, `at`);

CREATE INDEX `idx_integration_sync_log_tenant_id_at` ON `integration_sync_log` (`tenant_id`, `at`);
