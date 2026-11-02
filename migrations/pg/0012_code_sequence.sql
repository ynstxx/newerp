-- 0012_code_sequence · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 74 · 语句 1 · 2026-11-02T09:42:04.009Z

CREATE TABLE "code_seq" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "prefix" character varying(64) COLLATE "C" NOT NULL,
  "period" character varying(64) COLLATE "C" NOT NULL,
  "n" integer NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_code_seq_tenant_id_prefix_period" UNIQUE ("tenant_id", "prefix", "period")
);
