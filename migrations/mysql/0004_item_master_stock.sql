-- 0004_item_master_stock · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 29 · 语句 22 · 2026-11-02T08:16:20.318Z

CREATE TABLE `item` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `spec` varchar(64),
  `category` varchar(64),
  `base_uom` varchar(64) NOT NULL,
  `status` varchar(64) NOT NULL,
  `version` int NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_item_tenant_id_code` UNIQUE (`tenant_id`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_item_tenant_id_name` ON `item` (`tenant_id`, `name`);

CREATE INDEX `idx_item_tenant_id_category_status` ON `item` (`tenant_id`, `category`, `status`);

CREATE INDEX `idx_item_tenant_id_created_at_id` ON `item` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `item_uom` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `item_id` char(36) NOT NULL,
  `uom` varchar(64) NOT NULL,
  `ratio` decimal(18,2) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_item_uom_tenant_id_item_id_uom` UNIQUE (`tenant_id`, `item_id`, `uom`),
  CONSTRAINT `fk_item_uom_tenant_id_item_id` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `item` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_item_uom_tenant_id_item_id` ON `item_uom` (`tenant_id`, `item_id`);

CREATE TABLE `warehouse` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `name` varchar(64) NOT NULL,
  `status` varchar(64) NOT NULL,
  `version` int NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_warehouse_tenant_id_code` UNIQUE (`tenant_id`, `code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_warehouse_tenant_id_created_at_id` ON `warehouse` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `stock_bin` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `warehouse_id` char(36) NOT NULL,
  `item_id` char(36) NOT NULL,
  `qty` decimal(18,2) NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_stock_bin_tenant_id_warehouse_id_item_id` UNIQUE (`tenant_id`, `warehouse_id`, `item_id`),
  CONSTRAINT `fk_stock_bin_tenant_id_warehouse_id` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouse` (`tenant_id`, `id`),
  CONSTRAINT `fk_stock_bin_tenant_id_item_id` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `item` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_stock_bin_tenant_id_item_id_warehouse_id` ON `stock_bin` (`tenant_id`, `item_id`, `warehouse_id`);

CREATE INDEX `idx_stock_bin_tenant_id_created_at_id` ON `stock_bin` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `stock_move` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `warehouse_id` char(36) NOT NULL,
  `item_id` char(36) NOT NULL,
  `qty` decimal(18,2) NOT NULL,
  `dir` varchar(64) NOT NULL,
  `move_type` varchar(64) NOT NULL,
  `ref_type` varchar(64),
  `ref_id` varchar(64),
  `sn_list` text,
  `unit_cost` decimal(18,2),
  `note` text,
  `at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_stock_move_tenant_id_warehouse_id` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouse` (`tenant_id`, `id`),
  CONSTRAINT `fk_stock_move_tenant_id_item_id` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `item` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_stock_move_tenant_id_warehouse_id_item_id_at` ON `stock_move` (`tenant_id`, `warehouse_id`, `item_id`, `at`);

CREATE INDEX `idx_stock_move_tenant_id_ref_type_ref_id` ON `stock_move` (`tenant_id`, `ref_type`, `ref_id`);

CREATE INDEX `idx_stock_move_tenant_id_at_id` ON `stock_move` (`tenant_id`, `at`, `id`);

CREATE INDEX `idx_stock_move_tenant_id_at` ON `stock_move` (`tenant_id`, `at`);

CREATE TABLE `item_sn` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `item_id` char(36) NOT NULL,
  `sn` varchar(64) NOT NULL,
  `warehouse_id` char(36) NOT NULL,
  `status` varchar(64) NOT NULL,
  `ref_type` varchar(64),
  `ref_id` varchar(64),
  `created_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_item_sn_tenant_id_sn` UNIQUE (`tenant_id`, `sn`),
  CONSTRAINT `fk_item_sn_tenant_id_item_id` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `item` (`tenant_id`, `id`),
  CONSTRAINT `fk_item_sn_tenant_id_warehouse_id` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouse` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_item_sn_tenant_id_item_id_warehouse_id` ON `item_sn` (`tenant_id`, `item_id`, `warehouse_id`);

CREATE INDEX `idx_item_sn_tenant_id_created_at_id` ON `item_sn` (`tenant_id`, `created_at`, `id`);

CREATE TABLE `price_book` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `item_id` char(36) NOT NULL,
  `price_type` varchar(64) NOT NULL,
  `price` decimal(18,2) NOT NULL,
  `valid_from` datetime(3),
  `valid_to` datetime(3),
  `version` int NOT NULL,
  `created_at` datetime(3) NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `fk_price_book_tenant_id_item_id` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `item` (`tenant_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE INDEX `idx_price_book_tenant_id_item_id_price_type_valid_from` ON `price_book` (`tenant_id`, `item_id`, `price_type`, `valid_from`);

CREATE INDEX `idx_price_book_tenant_id_created_at_id` ON `price_book` (`tenant_id`, `created_at`, `id`);
