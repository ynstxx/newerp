-- 0001_init · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 11 · 语句 21 · 2026-11-01T18:08:27.343Z

CREATE TABLE `auth_user` (
  `id` char(36) NOT NULL,
  `email` varchar(64) NOT NULL,
  `pwd_hash` text NOT NULL,
  `pwd_salt` text NOT NULL,
  `display_name` varchar(64) NOT NULL,
  `status` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `uq_auth_user_email` UNIQUE (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `org_tenant` (
  `id` char(36) NOT NULL,
  `slug` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `status` varchar(64) NOT NULL,
  `plan` varchar(64) NOT NULL,
  `join_policy` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `uq_org_tenant_slug` UNIQUE (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `platform_settings` (
  `setting_key` varchar(64) NOT NULL,
  `setting_value` text NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `login_attempt` (
  `id` char(36) NOT NULL,
  `kind` varchar(64) NOT NULL,
  `ident` varchar(64) NOT NULL,
  `ip` varchar(64),
  `ok` tinyint(1) NOT NULL,
  `at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_login_attempt_ident_at` ON `login_attempt` (`ident`, `at`);

CREATE INDEX `idx_login_attempt_ip_at` ON `login_attempt` (`ip`, `at`);

CREATE TABLE `auth_session` (
  `id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `tenant_id` char(36),
  `expires_at` datetime(3) NOT NULL,
  `ip` varchar(64),
  `ua` text,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_auth_session_user_id` ON `auth_session` (`user_id`);

CREATE INDEX `idx_auth_session_expires_at` ON `auth_session` (`expires_at`);

CREATE TABLE `org_membership` (
  `user_id` char(36) NOT NULL,
  `role_id` char(36),
  `status` varchar(64) NOT NULL,
  `joined_at` datetime(3) NOT NULL,
  `tenant_id` char(36) NOT NULL,
  PRIMARY KEY (`tenant_id`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `auth_role` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `scope` varchar(64) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_auth_role_tenant_id_code` UNIQUE (`tenant_id`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `tenant_invite` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `email` varchar(64) NOT NULL,
  `code` varchar(64) NOT NULL,
  `role_id` char(36),
  `expires_at` datetime(3),
  `used_at` datetime(3),
  `created_by` char(36),
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_tenant_invite_tenant_id_code` UNIQUE (`tenant_id`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_tenant_invite_tenant_id_email` ON `tenant_invite` (`tenant_id`, `email`);

CREATE TABLE `party` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `party_type` varchar(64) NOT NULL,
  `tax_no` varchar(64),
  `contact_name` varchar(64),
  `phone` varchar(64),
  `email` varchar(64),
  `addr` text,
  `status` varchar(64) NOT NULL,
  `remark` text,
  `version` int NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_party_tenant_id_code` UNIQUE (`tenant_id`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_party_tenant_id_name` ON `party` (`tenant_id`, `name`);

CREATE INDEX `idx_party_tenant_id_party_type_status` ON `party` (`tenant_id`, `party_type`, `status`);

CREATE TABLE `party_contact` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `party_id` char(36) NOT NULL,
  `name` varchar(64) NOT NULL,
  `phone` varchar(64),
  `email` varchar(64),
  `title` varchar(64),
  `is_primary` tinyint(1) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_party_contact_tenant_id_party_id` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `party` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_party_contact_tenant_id_party_id` ON `party_contact` (`tenant_id`, `party_id`);

CREATE TABLE `audit_log` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `who_id` char(36),
  `module` varchar(64) NOT NULL,
  `action` varchar(64) NOT NULL,
  `ref_type` varchar(64),
  `ref_id` char(36),
  `before_json` json,
  `after_json` json,
  `trace_id` varchar(64),
  `at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_audit_log_tenant_id_at` ON `audit_log` (`tenant_id`, `at`);

CREATE INDEX `idx_audit_log_tenant_id_ref_type_ref_id` ON `audit_log` (`tenant_id`, `ref_type`, `ref_id`);
