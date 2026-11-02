-- 0007_approval_engine · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 46 · 语句 19 · 2026-11-02T08:22:35.437Z

CREATE TABLE `org_dept` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `parent_id` char(36),
  `name` varchar(64) NOT NULL,
  `path` text NOT NULL,
  `manager_user_id` char(36),
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `version` int NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_org_dept_tenant_id_parent_id` FOREIGN KEY (`tenant_id`, `parent_id`) REFERENCES `org_dept` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_org_dept_tenant_id_parent_id` ON `org_dept` (`tenant_id`, `parent_id`);

CREATE INDEX `idx_org_dept_tenant_id_manager_user_id` ON `org_dept` (`tenant_id`, `manager_user_id`);

CREATE TABLE `org_dept_member` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `dept_id` char(36) NOT NULL,
  `user_id` char(36) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `version` int NOT NULL DEFAULT 0,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_org_dept_member_tenant_id_dept_id_user_id` UNIQUE (`tenant_id`, `dept_id`, `user_id`),
  CONSTRAINT `fk_org_dept_member_tenant_id_dept_id` FOREIGN KEY (`tenant_id`, `dept_id`) REFERENCES `org_dept` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_org_dept_member_tenant_id_user_id` ON `org_dept_member` (`tenant_id`, `user_id`);

CREATE TABLE `approval_flow` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `doc_type` varchar(64) NOT NULL,
  `enabled` tinyint(1) NOT NULL DEFAULT true,
  `steps` json NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `version` int NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_approval_flow_tenant_id_code` UNIQUE (`tenant_id`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_approval_flow_tenant_id_doc_type_enabled` ON `approval_flow` (`tenant_id`, `doc_type`, `enabled`);

CREATE INDEX `idx_approval_flow_tenant_id_created_at_id` ON `approval_flow` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `approval_instance` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `flow_id` char(36) NOT NULL,
  `doc_type` varchar(64) NOT NULL,
  `doc_id` char(36) NOT NULL,
  `status` varchar(64) NOT NULL,
  `current_step` int NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  `flow_snapshot` json NOT NULL,
  `submitter_id` char(36) NOT NULL,
  `submitted_at` datetime(3) NOT NULL,
  `finished_at` datetime(3),
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `version` int NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_approval_instance_tenant_id_flow_id` FOREIGN KEY (`tenant_id`, `flow_id`) REFERENCES `approval_flow` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_approval_instance_tenant_id_doc_type_doc_id` ON `approval_instance` (`tenant_id`, `doc_type`, `doc_id`);

CREATE INDEX `idx_approval_instance_tenant_id_status` ON `approval_instance` (`tenant_id`, `status`);

CREATE INDEX `idx_approval_instance_tenant_id_submitter_id` ON `approval_instance` (`tenant_id`, `submitter_id`);

CREATE INDEX `idx_approval_instance_tenant_id_created_at_id` ON `approval_instance` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `approval_task` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `instance_id` char(36) NOT NULL,
  `step_no` int NOT NULL,
  `approver_user_id` char(36),
  `status` varchar(64) NOT NULL,
  `acted_at` datetime(3),
  `comment` text,
  `remind_count` int NOT NULL DEFAULT 0,
  `created_at` datetime(3) NOT NULL,
  `version` int NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_approval_task_tenant_id_instance_id_step_no_approver_user` UNIQUE (`tenant_id`, `instance_id`, `step_no`, `approver_user_id`),
  CONSTRAINT `fk_approval_task_tenant_id_instance_id` FOREIGN KEY (`tenant_id`, `instance_id`) REFERENCES `approval_instance` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_approval_task_tenant_id_approver_user_id_status` ON `approval_task` (`tenant_id`, `approver_user_id`, `status`);

CREATE INDEX `idx_approval_task_tenant_id_instance_id_step_no` ON `approval_task` (`tenant_id`, `instance_id`, `step_no`);

CREATE INDEX `idx_approval_task_tenant_id_status` ON `approval_task` (`tenant_id`, `status`);

CREATE TABLE `approval_event` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `instance_id` char(36) NOT NULL,
  `actor_id` char(36),
  `action` varchar(64) NOT NULL,
  `comment` text,
  `at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_approval_event_tenant_id_instance_id` FOREIGN KEY (`tenant_id`, `instance_id`) REFERENCES `approval_instance` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_approval_event_tenant_id_instance_id_at` ON `approval_event` (`tenant_id`, `instance_id`, `at`);
