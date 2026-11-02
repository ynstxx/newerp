-- 0002_m1_project_chain · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 22 · 语句 34 · 2026-11-02T06:47:59.972Z

CREATE TABLE `opportunity` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `party_id` char(36) NOT NULL,
  `owner_id` char(36),
  `stage` varchar(64) NOT NULL,
  `est_amount` decimal(18,2) NOT NULL,
  `expected_sign_at` datetime(3),
  `note` text,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `version` int NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_opportunity_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_opportunity_tenant_id_party_id` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `party` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_opportunity_tenant_id_party_id` ON `opportunity` (`tenant_id`, `party_id`);

CREATE INDEX `idx_opportunity_tenant_id_stage` ON `opportunity` (`tenant_id`, `stage`);

CREATE INDEX `idx_opportunity_tenant_id_owner_id` ON `opportunity` (`tenant_id`, `owner_id`);

CREATE TABLE `project` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `party_id` char(36) NOT NULL,
  `opportunity_id` char(36),
  `status` varchar(64) NOT NULL,
  `contract_amt` decimal(18,2) NOT NULL,
  `pm_user_id` char(36),
  `start_date` datetime(3),
  `end_date` datetime(3),
  `note` text,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  `version` int NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_project_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_project_tenant_id_party_id` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `party` (`tenant_id`, `id`),
  CONSTRAINT `fk_project_tenant_id_opportunity_id` FOREIGN KEY (`tenant_id`, `opportunity_id`) REFERENCES `opportunity` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_project_tenant_id_party_id` ON `project` (`tenant_id`, `party_id`);

CREATE INDEX `idx_project_tenant_id_status` ON `project` (`tenant_id`, `status`);

CREATE INDEX `idx_project_tenant_id_opportunity_id` ON `project` (`tenant_id`, `opportunity_id`);

CREATE INDEX `idx_project_tenant_id_pm_user_id` ON `project` (`tenant_id`, `pm_user_id`);

CREATE TABLE `project_stage_log` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `from_status` varchar(64),
  `to_status` varchar(64) NOT NULL,
  `actor_id` char(36),
  `note` text,
  `at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_project_stage_log_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_project_stage_log_tenant_id_project_id_at` ON `project_stage_log` (`tenant_id`, `project_id`, `at`);

CREATE TABLE `requirement` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `title` varchar(64) NOT NULL,
  `content` text,
  `status` varchar(64) NOT NULL,
  `confirmed_by` char(36),
  `confirmed_at` datetime(3),
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_requirement_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_requirement_tenant_id_project_id` ON `requirement` (`tenant_id`, `project_id`);

CREATE INDEX `idx_requirement_tenant_id_status` ON `requirement` (`tenant_id`, `status`);

CREATE TABLE `design_doc` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `title` varchar(64) NOT NULL,
  `version` int NOT NULL,
  `content` text,
  `status` varchar(64) NOT NULL,
  `confirmed_by` char(36),
  `confirmed_at` datetime(3),
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_design_doc_tenant_id_project_id_version` UNIQUE (`tenant_id`, `project_id`, `version`),
  CONSTRAINT `fk_design_doc_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_design_doc_tenant_id_project_id` ON `design_doc` (`tenant_id`, `project_id`);

CREATE INDEX `idx_design_doc_tenant_id_status` ON `design_doc` (`tenant_id`, `status`);

CREATE TABLE `bom_line` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `design_doc_id` char(36) NOT NULL,
  `line_no` int NOT NULL,
  `item_name` varchar(64) NOT NULL,
  `spec` varchar(64),
  `uom` varchar(64),
  `qty` decimal(18,2) NOT NULL,
  `unit_cost` decimal(18,2) NOT NULL,
  `note` text,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_bom_line_tenant_id_design_doc_id_line_no` UNIQUE (`tenant_id`, `design_doc_id`, `line_no`),
  CONSTRAINT `fk_bom_line_tenant_id_design_doc_id` FOREIGN KEY (`tenant_id`, `design_doc_id`) REFERENCES `design_doc` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_bom_line_tenant_id_design_doc_id` ON `bom_line` (`tenant_id`, `design_doc_id`);

CREATE TABLE `quotation` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `version` int NOT NULL,
  `party_id` char(36) NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  `valid_until` datetime(3),
  `status` varchar(64) NOT NULL,
  `sent_at` datetime(3),
  `decided_at` datetime(3),
  `note` text,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_quotation_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_quotation_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`),
  CONSTRAINT `fk_quotation_tenant_id_party_id` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `party` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_quotation_tenant_id_project_id` ON `quotation` (`tenant_id`, `project_id`);

CREATE INDEX `idx_quotation_tenant_id_party_id` ON `quotation` (`tenant_id`, `party_id`);

CREATE INDEX `idx_quotation_tenant_id_status` ON `quotation` (`tenant_id`, `status`);

CREATE TABLE `quotation_line` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `quotation_id` char(36) NOT NULL,
  `line_no` int NOT NULL,
  `item_name` varchar(64) NOT NULL,
  `spec` varchar(64),
  `uom` varchar(64),
  `qty` decimal(18,2) NOT NULL,
  `price` decimal(18,2) NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  `note` text,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_quotation_line_tenant_id_quotation_id_line_no` UNIQUE (`tenant_id`, `quotation_id`, `line_no`),
  CONSTRAINT `fk_quotation_line_tenant_id_quotation_id` FOREIGN KEY (`tenant_id`, `quotation_id`) REFERENCES `quotation` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_quotation_line_tenant_id_quotation_id` ON `quotation_line` (`tenant_id`, `quotation_id`);

CREATE TABLE `contract` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `project_id` char(36) NOT NULL,
  `quotation_id` char(36),
  `code` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `party_id` char(36) NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  `sign_at` datetime(3),
  `status` varchar(64) NOT NULL,
  `note` text,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_contract_tenant_id_code` UNIQUE (`tenant_id`, `code`),
  CONSTRAINT `fk_contract_tenant_id_project_id` FOREIGN KEY (`tenant_id`, `project_id`) REFERENCES `project` (`tenant_id`, `id`),
  CONSTRAINT `fk_contract_tenant_id_party_id` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `party` (`tenant_id`, `id`),
  CONSTRAINT `fk_contract_tenant_id_quotation_id` FOREIGN KEY (`tenant_id`, `quotation_id`) REFERENCES `quotation` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_contract_tenant_id_project_id` ON `contract` (`tenant_id`, `project_id`);

CREATE INDEX `idx_contract_tenant_id_party_id` ON `contract` (`tenant_id`, `party_id`);

CREATE INDEX `idx_contract_tenant_id_status` ON `contract` (`tenant_id`, `status`);

CREATE INDEX `idx_contract_tenant_id_quotation_id` ON `contract` (`tenant_id`, `quotation_id`);

CREATE TABLE `contract_line` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `contract_id` char(36) NOT NULL,
  `line_no` int NOT NULL,
  `item_name` varchar(64) NOT NULL,
  `spec` varchar(64),
  `uom` varchar(64),
  `qty` decimal(18,2) NOT NULL,
  `price` decimal(18,2) NOT NULL,
  `amount` decimal(18,2) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_contract_line_tenant_id_contract_id_line_no` UNIQUE (`tenant_id`, `contract_id`, `line_no`),
  CONSTRAINT `fk_contract_line_tenant_id_contract_id` FOREIGN KEY (`tenant_id`, `contract_id`) REFERENCES `contract` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_contract_line_tenant_id_contract_id` ON `contract_line` (`tenant_id`, `contract_id`);

CREATE TABLE `contract_term` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `contract_id` char(36) NOT NULL,
  `seq` int NOT NULL,
  `title` varchar(64) NOT NULL,
  `content` text NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_contract_term_tenant_id_contract_id_seq` UNIQUE (`tenant_id`, `contract_id`, `seq`),
  CONSTRAINT `fk_contract_term_tenant_id_contract_id` FOREIGN KEY (`tenant_id`, `contract_id`) REFERENCES `contract` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_contract_term_tenant_id_contract_id` ON `contract_term` (`tenant_id`, `contract_id`);
