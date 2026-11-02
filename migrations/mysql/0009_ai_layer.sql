-- 0009_ai_layer · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 53 · 语句 9 · 2026-11-02T08:32:56.576Z

CREATE TABLE `ai_settings` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `base_url` text,
  `api_key` text,
  `model` varchar(64),
  `enabled` tinyint(1) NOT NULL DEFAULT false,
  `max_tokens` int NOT NULL DEFAULT 1024,
  `timeout_ms` int NOT NULL DEFAULT 15000,
  `monthly_token_limit` int NOT NULL DEFAULT 0,
  `used_tokens` int NOT NULL DEFAULT 0,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_ai_settings_tenant_id_enabled` ON `ai_settings` (`tenant_id`, `enabled`);

CREATE TABLE `ai_draft` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `tool_name` varchar(64) NOT NULL,
  `payload` json NOT NULL,
  `preview` json NOT NULL,
  `status` varchar(64) NOT NULL,
  `submitter_id` char(36) NOT NULL,
  `applied_ref_type` varchar(64),
  `applied_ref_id` char(36),
  `error` text,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_ai_draft_tenant_id_status` ON `ai_draft` (`tenant_id`, `status`);

CREATE INDEX `idx_ai_draft_tenant_id_tool_name` ON `ai_draft` (`tenant_id`, `tool_name`);

CREATE INDEX `idx_ai_draft_tenant_id_created_at_id` ON `ai_draft` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `ai_trace` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `draft_id` char(36),
  `model` varchar(64),
  `prompt_tokens` int NOT NULL DEFAULT 0,
  `completion_tokens` int NOT NULL DEFAULT 0,
  `cost_micros` int NOT NULL DEFAULT 0,
  `duration_ms` int NOT NULL DEFAULT 0,
  `tool_calls` json,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_ai_trace_tenant_id_created_at_id` ON `ai_trace` (`tenant_id`, `created_at`, `id`);

CREATE INDEX `idx_ai_trace_tenant_id_draft_id` ON `ai_trace` (`tenant_id`, `draft_id`);
