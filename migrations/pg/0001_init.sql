-- 0001_init · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 11 · 语句 21 · 2026-11-01T18:08:27.336Z

CREATE TABLE "auth_user" (
  "id" uuid NOT NULL,
  "email" character varying(64) COLLATE "C" NOT NULL,
  "pwd_hash" text COLLATE "C" NOT NULL,
  "pwd_salt" text COLLATE "C" NOT NULL,
  "display_name" character varying(64) COLLATE "C" NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_auth_user_email" UNIQUE ("email")
);

CREATE TABLE "org_tenant" (
  "id" uuid NOT NULL,
  "slug" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "plan" character varying(64) COLLATE "C" NOT NULL,
  "join_policy" character varying(64) COLLATE "C" NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "uq_org_tenant_slug" UNIQUE ("slug")
);

CREATE TABLE "platform_settings" (
  "setting_key" character varying(64) COLLATE "C" NOT NULL,
  "setting_value" text COLLATE "C" NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("setting_key")
);

CREATE TABLE "login_attempt" (
  "id" uuid NOT NULL,
  "kind" character varying(64) COLLATE "C" NOT NULL,
  "ident" character varying(64) COLLATE "C" NOT NULL,
  "ip" character varying(64) COLLATE "C",
  "ok" boolean NOT NULL,
  "at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("id")
);

CREATE INDEX "idx_login_attempt_ident_at" ON "login_attempt" ("ident", "at");

CREATE INDEX "idx_login_attempt_ip_at" ON "login_attempt" ("ip", "at");

CREATE TABLE "auth_session" (
  "id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "tenant_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "ip" character varying(64) COLLATE "C",
  "ua" text COLLATE "C",
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("id")
);

CREATE INDEX "idx_auth_session_user_id" ON "auth_session" ("user_id");

CREATE INDEX "idx_auth_session_expires_at" ON "auth_session" ("expires_at");

CREATE TABLE "org_membership" (
  "user_id" uuid NOT NULL,
  "role_id" uuid,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "joined_at" timestamp with time zone NOT NULL,
  "tenant_id" uuid NOT NULL,
  PRIMARY KEY ("tenant_id", "user_id")
);

CREATE TABLE "auth_role" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "scope" character varying(64) COLLATE "C" NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_auth_role_tenant_id_code" UNIQUE ("tenant_id", "code")
);

CREATE TABLE "tenant_invite" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "email" character varying(64) COLLATE "C" NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "role_id" uuid,
  "expires_at" timestamp with time zone,
  "used_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_tenant_invite_tenant_id_code" UNIQUE ("tenant_id", "code")
);

CREATE INDEX "idx_tenant_invite_tenant_id_email" ON "tenant_invite" ("tenant_id", "email");

CREATE TABLE "party" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "party_type" character varying(64) COLLATE "C" NOT NULL,
  "tax_no" character varying(64) COLLATE "C",
  "contact_name" character varying(64) COLLATE "C",
  "phone" character varying(64) COLLATE "C",
  "email" character varying(64) COLLATE "C",
  "addr" text COLLATE "C",
  "status" character varying(64) COLLATE "C" NOT NULL,
  "remark" text COLLATE "C",
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_party_tenant_id_code" UNIQUE ("tenant_id", "code")
);

CREATE INDEX "idx_party_tenant_id_name" ON "party" ("tenant_id", "name");

CREATE INDEX "idx_party_tenant_id_party_type_status" ON "party" ("tenant_id", "party_type", "status");

CREATE TABLE "party_contact" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "party_id" uuid NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "phone" character varying(64) COLLATE "C",
  "email" character varying(64) COLLATE "C",
  "title" character varying(64) COLLATE "C",
  "is_primary" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_party_contact_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id")
);

CREATE INDEX "idx_party_contact_tenant_id_party_id" ON "party_contact" ("tenant_id", "party_id");

CREATE TABLE "audit_log" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "who_id" uuid,
  "module" character varying(64) COLLATE "C" NOT NULL,
  "action" character varying(64) COLLATE "C" NOT NULL,
  "ref_type" character varying(64) COLLATE "C",
  "ref_id" uuid,
  "before_json" jsonb,
  "after_json" jsonb,
  "trace_id" character varying(64) COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id")
);

CREATE INDEX "idx_audit_log_tenant_id_at" ON "audit_log" ("tenant_id", "at");

CREATE INDEX "idx_audit_log_tenant_id_ref_type_ref_id" ON "audit_log" ("tenant_id", "ref_type", "ref_id");
