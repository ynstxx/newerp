-- 0012_code_sequence · mysql · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 74 · 语句 1 · 2026-11-02T09:42:04.016Z

CREATE TABLE `code_seq` (
  `tenant_id` char(36) NOT NULL,
  `id` char(36) NOT NULL,
  `prefix` varchar(64) NOT NULL,
  `period` varchar(64) NOT NULL,
  `n` int NOT NULL,
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`tenant_id`, `id`),
  CONSTRAINT `uq_code_seq_tenant_id_prefix_period` UNIQUE (`tenant_id`, `prefix`, `period`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
