-- 0008_notify_center · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 50 · 语句 10 · 2026-11-02T08:24:46.323Z

CREATE TABLE "notify_channel" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "type" character varying(64) COLLATE "C" NOT NULL,
  "enabled" boolean NOT NULL,
  "config" jsonb,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_notify_channel_tenant_id_type" UNIQUE ("tenant_id", "type")
);

CREATE TABLE "notify_template" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "channel" character varying(64) COLLATE "C" NOT NULL,
  "lang" character varying(64) COLLATE "C" NOT NULL,
  "subject" text COLLATE "C",
  "body" text COLLATE "C" NOT NULL,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_notify_template_tenant_id_code_channel_lang" UNIQUE ("tenant_id", "code", "channel", "lang")
);

CREATE INDEX "idx_notify_template_tenant_id_channel" ON "notify_template" ("tenant_id", "channel");

CREATE TABLE "notify_outbox" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "channel" character varying(64) COLLATE "C" NOT NULL,
  "to_addr" character varying(64) COLLATE "C" NOT NULL,
  "template_code" character varying(64) COLLATE "C" NOT NULL,
  "vars" jsonb,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "attempts" integer NOT NULL,
  "next_retry_at" timestamp with time zone,
  "error" text COLLATE "C",
  "dedupe_key" character varying(64) COLLATE "C" NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_notify_outbox_tenant_id_dedupe_key" UNIQUE ("tenant_id", "dedupe_key")
);

CREATE INDEX "idx_notify_outbox_tenant_id_status_next_retry_at" ON "notify_outbox" ("tenant_id", "status", "next_retry_at");

CREATE INDEX "idx_notify_outbox_tenant_id_template_code" ON "notify_outbox" ("tenant_id", "template_code");

CREATE INDEX "idx_notify_outbox_tenant_id_created_at_id" ON "notify_outbox" ("tenant_id", "created_at", "id");

CREATE TABLE "notify_inbox" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "title" text COLLATE "C" NOT NULL,
  "body" text COLLATE "C",
  "link" character varying(64) COLLATE "C",
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);

CREATE INDEX "idx_notify_inbox_tenant_id_user_id_read_at_created_at" ON "notify_inbox" ("tenant_id", "user_id", "read_at", "created_at");

CREATE INDEX "idx_notify_inbox_tenant_id_created_at_id" ON "notify_inbox" ("tenant_id", "created_at", "id");
