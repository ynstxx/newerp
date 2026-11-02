-- 0007_approval_engine · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 46 · 语句 19 · 2026-11-02T08:22:35.429Z

CREATE TABLE "org_dept" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "parent_id" uuid,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "path" text COLLATE "C" NOT NULL,
  "manager_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_org_dept_tenant_id_parent_id" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "org_dept" ("tenant_id", "id")
);

CREATE INDEX "idx_org_dept_tenant_id_parent_id" ON "org_dept" ("tenant_id", "parent_id");

CREATE INDEX "idx_org_dept_tenant_id_manager_user_id" ON "org_dept" ("tenant_id", "manager_user_id");

CREATE TABLE "org_dept_member" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "dept_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_org_dept_member_tenant_id_dept_id_user_id" UNIQUE ("tenant_id", "dept_id", "user_id"),
  CONSTRAINT "fk_org_dept_member_tenant_id_dept_id" FOREIGN KEY ("tenant_id", "dept_id") REFERENCES "org_dept" ("tenant_id", "id")
);

CREATE INDEX "idx_org_dept_member_tenant_id_user_id" ON "org_dept_member" ("tenant_id", "user_id");

CREATE TABLE "approval_flow" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "doc_type" character varying(64) COLLATE "C" NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "steps" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_approval_flow_tenant_id_code" UNIQUE ("tenant_id", "code")
);

CREATE INDEX "idx_approval_flow_tenant_id_doc_type_enabled" ON "approval_flow" ("tenant_id", "doc_type", "enabled");

CREATE INDEX "idx_approval_flow_tenant_id_created_at_id" ON "approval_flow" ("tenant_id", "created_at", "id");

CREATE TABLE "approval_instance" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "flow_id" uuid NOT NULL,
  "doc_type" character varying(64) COLLATE "C" NOT NULL,
  "doc_id" uuid NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "current_step" integer NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  "flow_snapshot" jsonb NOT NULL,
  "submitter_id" uuid NOT NULL,
  "submitted_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_approval_instance_tenant_id_flow_id" FOREIGN KEY ("tenant_id", "flow_id") REFERENCES "approval_flow" ("tenant_id", "id")
);

CREATE INDEX "idx_approval_instance_tenant_id_doc_type_doc_id" ON "approval_instance" ("tenant_id", "doc_type", "doc_id");

CREATE INDEX "idx_approval_instance_tenant_id_status" ON "approval_instance" ("tenant_id", "status");

CREATE INDEX "idx_approval_instance_tenant_id_submitter_id" ON "approval_instance" ("tenant_id", "submitter_id");

CREATE INDEX "idx_approval_instance_tenant_id_created_at_id" ON "approval_instance" ("tenant_id", "created_at", "id");

CREATE TABLE "approval_task" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "instance_id" uuid NOT NULL,
  "step_no" integer NOT NULL,
  "approver_user_id" uuid,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "acted_at" timestamp with time zone,
  "comment" text COLLATE "C",
  "remind_count" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_approval_task_tenant_id_instance_id_step_no_approver_user" UNIQUE ("tenant_id", "instance_id", "step_no", "approver_user_id"),
  CONSTRAINT "fk_approval_task_tenant_id_instance_id" FOREIGN KEY ("tenant_id", "instance_id") REFERENCES "approval_instance" ("tenant_id", "id")
);

CREATE INDEX "idx_approval_task_tenant_id_approver_user_id_status" ON "approval_task" ("tenant_id", "approver_user_id", "status");

CREATE INDEX "idx_approval_task_tenant_id_instance_id_step_no" ON "approval_task" ("tenant_id", "instance_id", "step_no");

CREATE INDEX "idx_approval_task_tenant_id_status" ON "approval_task" ("tenant_id", "status");

CREATE TABLE "approval_event" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "instance_id" uuid NOT NULL,
  "actor_id" uuid,
  "action" character varying(64) COLLATE "C" NOT NULL,
  "comment" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_approval_event_tenant_id_instance_id" FOREIGN KEY ("tenant_id", "instance_id") REFERENCES "approval_instance" ("tenant_id", "id")
);

CREATE INDEX "idx_approval_event_tenant_id_instance_id_at" ON "approval_event" ("tenant_id", "instance_id", "at");
