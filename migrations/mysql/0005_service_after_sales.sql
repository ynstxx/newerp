-- 0005_service_after_sales · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 37 · 语句 28 · 2026-11-02T08:18:42.200Z

CREATE TABLE `service_contract` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `party_id` char(36) NOT NULL,
  `name` varchar(64) NOT NULL,
  `start_at` datetime(3),
  `end_at` datetime(3),
  `sla_level` varchar(64) NOT NULL DEFAULT 'P2',
  `response_minutes` int NOT NULL DEFAULT 60,
  `resolve_minutes` int NOT NULL DEFAULT 480,
  `amount` decimal(18,2) NOT NULL DEFAULT 0.00,
  `status` varchar(64) NOT NULL DEFAULT 'active',
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_service_contract_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_service_contract_tenant_id_party_id` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `party` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_service_contract_tenant_id_party_id` ON `service_contract` (`tenant_id`, `party_id`);

CREATE INDEX `idx_service_contract_tenant_id_status` ON `service_contract` (`tenant_id`, `status`);

CREATE INDEX `idx_service_contract_tenant_id_created_at_id` ON `service_contract` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `ticket` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `contract_id` char(36),
  `party_id` char(36) NOT NULL,
  `title` varchar(64) NOT NULL,
  `content` text,
  `sn` varchar(64),
  `priority` varchar(64) NOT NULL DEFAULT 'normal',
  `status` varchar(64) NOT NULL DEFAULT '待受理',
  `assignee_id` char(36),
  `reported_at` datetime(3) NOT NULL,
  `responded_at` datetime(3),
  `resolved_at` datetime(3),
  `sla_due_at` datetime(3),
  `version` int NOT NULL DEFAULT 1,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_ticket_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_ticket_tenant_id_contract_id` FOREIGN KEY (`tenant_id`, `contract_id`) REFERENCES `service_contract` (`tenant_id`, `id`),
  CONSTRAINT `fk_ticket_tenant_id_party_id` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `party` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_ticket_tenant_id_contract_id` ON `ticket` (`tenant_id`, `contract_id`);

CREATE INDEX `idx_ticket_tenant_id_party_id` ON `ticket` (`tenant_id`, `party_id`);

CREATE INDEX `idx_ticket_tenant_id_status` ON `ticket` (`tenant_id`, `status`);

CREATE INDEX `idx_ticket_tenant_id_priority` ON `ticket` (`tenant_id`, `priority`);

CREATE INDEX `idx_ticket_tenant_id_sn` ON `ticket` (`tenant_id`, `sn`);

CREATE INDEX `idx_ticket_tenant_id_assignee_id` ON `ticket` (`tenant_id`, `assignee_id`);

CREATE INDEX `idx_ticket_tenant_id_created_at_id` ON `ticket` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `ticket_event` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `ticket_id` char(36) NOT NULL,
  `actor_id` char(36),
  `action` varchar(64) NOT NULL,
  `comment` text,
  `at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_ticket_event_tenant_id_ticket_id` FOREIGN KEY (`tenant_id`, `ticket_id`) REFERENCES `ticket` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_ticket_event_tenant_id_ticket_id_at` ON `ticket_event` (`tenant_id`, `ticket_id`, `at`);

CREATE TABLE `dispatch` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `ticket_id` char(36) NOT NULL,
  `engineer_id` char(36) NOT NULL,
  `assigned_at` datetime(3) NOT NULL,
  `accepted_at` datetime(3),
  `finished_at` datetime(3),
  `note` text,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_dispatch_tenant_id_ticket_id` FOREIGN KEY (`tenant_id`, `ticket_id`) REFERENCES `ticket` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_dispatch_tenant_id_ticket_id` ON `dispatch` (`tenant_id`, `ticket_id`);

CREATE INDEX `idx_dispatch_tenant_id_engineer_id` ON `dispatch` (`tenant_id`, `engineer_id`);

CREATE TABLE `maintenance_plan` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `contract_id` char(36) NOT NULL,
  `name` varchar(64) NOT NULL,
  `cron_note` varchar(64),
  `next_at` datetime(3),
  `enabled` tinyint(1) NOT NULL DEFAULT TRUE,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_maintenance_plan_tenant_id_contract_id` FOREIGN KEY (`tenant_id`, `contract_id`) REFERENCES `service_contract` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_maintenance_plan_tenant_id_contract_id` ON `maintenance_plan` (`tenant_id`, `contract_id`);

CREATE INDEX `idx_maintenance_plan_tenant_id_next_at` ON `maintenance_plan` (`tenant_id`, `next_at`);

CREATE INDEX `idx_maintenance_plan_tenant_id_created_at_id` ON `maintenance_plan` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `maintenance_task` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `plan_id` char(36) NOT NULL,
  `due_at` datetime(3) NOT NULL,
  `done_at` datetime(3),
  `result` text,
  `assignee_id` char(36),
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_maintenance_task_tenant_id_plan_id` FOREIGN KEY (`tenant_id`, `plan_id`) REFERENCES `maintenance_plan` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_maintenance_task_tenant_id_plan_id_due_at` ON `maintenance_task` (`tenant_id`, `plan_id`, `due_at`);

CREATE INDEX `idx_maintenance_task_tenant_id_done_at` ON `maintenance_task` (`tenant_id`, `done_at`);

CREATE TABLE `spare_part_move` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `ticket_id` char(36) NOT NULL,
  `item_name` varchar(64) NOT NULL,
  `qty` decimal(18,2) NOT NULL,
  `dir` varchar(64) NOT NULL,
  `note` text,
  `at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_spare_part_move_tenant_id_ticket_id` FOREIGN KEY (`tenant_id`, `ticket_id`) REFERENCES `ticket` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_spare_part_move_tenant_id_ticket_id_at` ON `spare_part_move` (`tenant_id`, `ticket_id`, `at`);

CREATE TABLE `satisfaction` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `ticket_id` char(36) NOT NULL,
  `score` int NOT NULL,
  `comment` text,
  `at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_satisfaction_tenant_id_ticket_id` FOREIGN KEY (`tenant_id`, `ticket_id`) REFERENCES `ticket` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_satisfaction_tenant_id_ticket_id_at` ON `satisfaction` (`tenant_id`, `ticket_id`, `at`);
