-- 0006_integration · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 40 · 语句 8 · 2026-11-02T08:21:20.953Z

CREATE TABLE "integration_conn" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "provider" character varying(64) COLLATE "C" NOT NULL,
  "corp_id" character varying(64) COLLATE "C",
  "agent_id" character varying(64) COLLATE "C",
  "secrets" jsonb,
  "enabled" boolean NOT NULL DEFAULT false,
  "last_sync_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_integration_conn_tenant_id_provider" UNIQUE ("tenant_id", "provider")
);

CREATE INDEX "idx_integration_conn_tenant_id_enabled" ON "integration_conn" ("tenant_id", "enabled");

CREATE TABLE "integration_map" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "provider" character varying(64) COLLATE "C" NOT NULL,
  "external_type" character varying(64) COLLATE "C" NOT NULL,
  "external_id" character varying(64) COLLATE "C" NOT NULL,
  "local_id" character varying(64) COLLATE "C" NOT NULL,
  "synced_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_integration_map_tenant_id_provider_external_type_external" UNIQUE ("tenant_id", "provider", "external_type", "external_id")
);

CREATE INDEX "idx_integration_map_tenant_id_provider_external_type_local_i" ON "integration_map" ("tenant_id", "provider", "external_type", "local_id");

CREATE INDEX "idx_integration_map_tenant_id_provider_external_type" ON "integration_map" ("tenant_id", "provider", "external_type");

CREATE TABLE "integration_sync_log" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "provider" character varying(64) COLLATE "C" NOT NULL,
  "action" character varying(64) COLLATE "C" NOT NULL,
  "counts" jsonb,
  "error" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);

CREATE INDEX "idx_integration_sync_log_tenant_id_provider_at" ON "integration_sync_log" ("tenant_id", "provider", "at");

CREATE INDEX "idx_integration_sync_log_tenant_id_at" ON "integration_sync_log" ("tenant_id", "at");
