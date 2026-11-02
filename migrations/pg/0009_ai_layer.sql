-- 0009_ai_layer · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 53 · 语句 9 · 2026-11-02T08:32:56.562Z

CREATE TABLE "ai_settings" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "base_url" text COLLATE "C",
  "api_key" text COLLATE "C",
  "model" character varying(64) COLLATE "C",
  "enabled" boolean NOT NULL DEFAULT false,
  "max_tokens" integer NOT NULL DEFAULT 1024,
  "timeout_ms" integer NOT NULL DEFAULT 15000,
  "monthly_token_limit" integer NOT NULL DEFAULT 0,
  "used_tokens" integer NOT NULL DEFAULT 0,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);

CREATE INDEX "idx_ai_settings_tenant_id_enabled" ON "ai_settings" ("tenant_id", "enabled");

CREATE TABLE "ai_draft" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "tool_name" character varying(64) COLLATE "C" NOT NULL,
  "payload" jsonb NOT NULL,
  "preview" jsonb NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "submitter_id" uuid NOT NULL,
  "applied_ref_type" character varying(64) COLLATE "C",
  "applied_ref_id" uuid,
  "error" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);

CREATE INDEX "idx_ai_draft_tenant_id_status" ON "ai_draft" ("tenant_id", "status");

CREATE INDEX "idx_ai_draft_tenant_id_tool_name" ON "ai_draft" ("tenant_id", "tool_name");

CREATE INDEX "idx_ai_draft_tenant_id_created_at_id" ON "ai_draft" ("tenant_id", "created_at", "id");

CREATE TABLE "ai_trace" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "draft_id" uuid,
  "model" character varying(64) COLLATE "C",
  "prompt_tokens" integer NOT NULL DEFAULT 0,
  "completion_tokens" integer NOT NULL DEFAULT 0,
  "cost_micros" integer NOT NULL DEFAULT 0,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "tool_calls" jsonb,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);

CREATE INDEX "idx_ai_trace_tenant_id_created_at_id" ON "ai_trace" ("tenant_id", "created_at", "id");

CREATE INDEX "idx_ai_trace_tenant_id_draft_id" ON "ai_trace" ("tenant_id", "draft_id");
