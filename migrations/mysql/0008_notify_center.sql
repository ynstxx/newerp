-- 0008_notify_center · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 50 · 语句 10 · 2026-11-02T08:24:46.331Z

CREATE TABLE `notify_channel` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `type` varchar(64) NOT NULL,
  `enabled` tinyint(1) NOT NULL,
  `config` json,
  `version` int NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_notify_channel_tenant_id_type` UNIQUE (`tenant_id`, `type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `notify_template` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `channel` varchar(64) NOT NULL,
  `lang` varchar(64) NOT NULL,
  `subject` text,
  `body` text NOT NULL,
  `version` int NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_notify_template_tenant_id_code_channel_lang` UNIQUE (`tenant_id`, `code`, `channel`, `lang`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_notify_template_tenant_id_channel` ON `notify_template` (`tenant_id`, `channel`);

CREATE TABLE `notify_outbox` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `channel` varchar(64) NOT NULL,
  `to_addr` varchar(64) NOT NULL,
  `template_code` varchar(64) NOT NULL,
  `vars` json,
  `status` varchar(64) NOT NULL,
  `attempts` int NOT NULL,
  `next_retry_at` datetime(3),
  `error` text,
  `dedupe_key` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_notify_outbox_tenant_id_dedupe_key` UNIQUE (`tenant_id`, `dedupe_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_notify_outbox_tenant_id_status_next_retry_at` ON `notify_outbox` (`tenant_id`, `status`, `next_retry_at`);

CREATE INDEX `idx_notify_outbox_tenant_id_template_code` ON `notify_outbox` (`tenant_id`, `template_code`);

CREATE INDEX `idx_notify_outbox_tenant_id_created_at_id` ON `notify_outbox` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `notify_inbox` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `title` text NOT NULL,
  `body` text,
  `link` varchar(64),
  `read_at` datetime(3),
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_notify_inbox_tenant_id_user_id_read_at_created_at` ON `notify_inbox` (`tenant_id`, `user_id`, `read_at`, `created_at`);

CREATE INDEX `idx_notify_inbox_tenant_id_created_at_id` ON `notify_inbox` (`tenant_id`, `created_at`, `id`);
