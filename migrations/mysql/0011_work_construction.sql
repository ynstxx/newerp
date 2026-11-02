-- 0011_work_construction · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 73 · 语句 37 · 2026-11-02T08:41:53.486Z

CREATE TABLE `work_plan` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `plan_start` datetime(3),
  `plan_end` datetime(3),
  `note` text,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_work_plan_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_work_plan_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_work_plan_tenant_id_project_id` ON `work_plan` (`tenant_id`, `project_id`);

CREATE INDEX `idx_work_plan_tenant_id_created_at_id` ON `work_plan` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `work_task` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `plan_id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `title` varchar(64) NOT NULL,
  `assignee_id` char(36),
  `status` varchar(64) NOT NULL DEFAULT 'todo',
  `progress` int NOT NULL DEFAULT 0,
  `plan_start` datetime(3),
  `plan_end` datetime(3),
  `note` text,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_work_task_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_work_task_tenant_id_plan_id` FOREIGN KEY (`tenant_id`, `plan_id`) REFERENCES `work_plan` (`tenant_id`, `id`),
  CONSTRAINT `fk_work_task_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_work_task_tenant_id_plan_id` ON `work_task` (`tenant_id`, `plan_id`);

CREATE INDEX `idx_work_task_tenant_id_project_id_status` ON `work_task` (`tenant_id`, `project_id`, `status`);

CREATE INDEX `idx_work_task_tenant_id_assignee_id` ON `work_task` (`tenant_id`, `assignee_id`);

CREATE INDEX `idx_work_task_tenant_id_created_at_id` ON `work_task` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `progress_log` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `task_id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `reporter_id` char(36),
  `progress` int NOT NULL,
  `content` text,
  `at` datetime(3) NOT NULL,
  `version` int NOT NULL DEFAULT 0,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_progress_log_tenant_id_task_id` FOREIGN KEY (`tenant_id`, `task_id`) REFERENCES `work_task` (`tenant_id`, `id`),
  CONSTRAINT `fk_progress_log_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_progress_log_tenant_id_task_id_at` ON `progress_log` (`tenant_id`, `task_id`, `at`);

CREATE INDEX `idx_progress_log_tenant_id_project_id_at` ON `progress_log` (`tenant_id`, `project_id`, `at`);

CREATE INDEX `idx_progress_log_tenant_id_created_at_id` ON `progress_log` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `material_issue` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `warehouse_id` char(36) NOT NULL,
  `applicant_id` char(36),
  `amount` decimal(18,2) NOT NULL DEFAULT 0.00,
  `status` varchar(64) NOT NULL DEFAULT 'draft',
  `approval_instance_id` char(36),
  `error_message` text,
  `note` text,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_material_issue_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_material_issue_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`),
  CONSTRAINT `fk_material_issue_tenant_id_warehouse_id` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouse` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_material_issue_tenant_id_project_id` ON `material_issue` (`tenant_id`, `project_id`);

CREATE INDEX `idx_material_issue_tenant_id_warehouse_id` ON `material_issue` (`tenant_id`, `warehouse_id`);

CREATE INDEX `idx_material_issue_tenant_id_status` ON `material_issue` (`tenant_id`, `status`);

CREATE INDEX `idx_material_issue_tenant_id_created_at_id` ON `material_issue` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `material_issue_line` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `issue_id` char(36) NOT NULL,
  `item_id` char(36) NOT NULL,
  `qty` decimal(18,2) NOT NULL,
  `unit_cost` decimal(18,2),
  `note` text,
  `version` int NOT NULL DEFAULT 0,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_material_issue_line_tenant_id_issue_id` FOREIGN KEY (`tenant_id`, `issue_id`) REFERENCES `material_issue` (`tenant_id`, `id`),
  CONSTRAINT `fk_material_issue_line_tenant_id_item_id` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `item` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_material_issue_line_tenant_id_issue_id` ON `material_issue_line` (`tenant_id`, `issue_id`);

CREATE INDEX `idx_material_issue_line_tenant_id_item_id` ON `material_issue_line` (`tenant_id`, `item_id`);

CREATE INDEX `idx_material_issue_line_tenant_id_issue_id_created_at` ON `material_issue_line` (`tenant_id`, `issue_id`, `created_at`);

CREATE TABLE `change_order` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `title` varchar(64) NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  `reason` text,
  `status` varchar(64) NOT NULL DEFAULT 'draft',
  `approval_instance_id` char(36),
  `applied_at` datetime(3),
  `error_message` text,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_change_order_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_change_order_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_change_order_tenant_id_project_id` ON `change_order` (`tenant_id`, `project_id`);

CREATE INDEX `idx_change_order_tenant_id_status` ON `change_order` (`tenant_id`, `status`);

CREATE INDEX `idx_change_order_tenant_id_created_at_id` ON `change_order` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `acceptance` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `type` varchar(64) NOT NULL,
  `status` varchar(64) NOT NULL DEFAULT 'draft',
  `items` json NOT NULL,
  `conclusion` text,
  `accepted_by` char(36),
  `accepted_at` datetime(3),
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_acceptance_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_acceptance_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_acceptance_tenant_id_project_id` ON `acceptance` (`tenant_id`, `project_id`);

CREATE INDEX `idx_acceptance_tenant_id_type_status` ON `acceptance` (`tenant_id`, `type`, `status`);

CREATE INDEX `idx_acceptance_tenant_id_created_at_id` ON `acceptance` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `labor_hour` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `task_id` char(36),
  `user_id` char(36) NOT NULL,
  `work_date` datetime(3) NOT NULL,
  `hours` decimal(18,2) NOT NULL,
  `note` text,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_labor_hour_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`),
  CONSTRAINT `fk_labor_hour_tenant_id_task_id` FOREIGN KEY (`tenant_id`, `task_id`) REFERENCES `work_task` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_labor_hour_tenant_id_project_id_work_date` ON `labor_hour` (`tenant_id`, `project_id`, `work_date`);

CREATE INDEX `idx_labor_hour_tenant_id_user_id` ON `labor_hour` (`tenant_id`, `user_id`);

CREATE INDEX `idx_labor_hour_tenant_id_task_id` ON `labor_hour` (`tenant_id`, `task_id`);

CREATE INDEX `idx_labor_hour_tenant_id_created_at_id` ON `labor_hour` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `site_record` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `author_id` char(36),
  `recorded_at` datetime(3) NOT NULL,
  `weather` varchar(64),
  `content` text NOT NULL,
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_site_record_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_site_record_tenant_id_project_id_recorded_at` ON `site_record` (`tenant_id`, `project_id`, `recorded_at`);

CREATE INDEX `idx_site_record_tenant_id_created_at_id` ON `site_record` (`tenant_id`, `created_at`, `id`);
