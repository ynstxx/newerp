-- 0013_tenant_config · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 75 · 语句 1 · 2026-11-02T10:26:03.921Z

CREATE TABLE "sys_config" (
  "config_key" character varying(64) COLLATE "C" NOT NULL,
  "config_value" character varying(64) COLLATE "C" NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "tenant_id" uuid NOT NULL,
  PRIMARY KEY ("tenant_id", "config_key")
);
