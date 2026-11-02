-- 0011_work_construction · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 73 · 语句 37 · 2026-11-02T08:41:53.479Z

CREATE TABLE "work_plan" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "plan_start" timestamp with time zone,
  "plan_end" timestamp with time zone,
  "note" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_work_plan_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_work_plan_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_work_plan_tenant_id_project_id" ON "work_plan" ("tenant_id", "project_id");

CREATE INDEX "idx_work_plan_tenant_id_created_at_id" ON "work_plan" ("tenant_id", "created_at", "id");

CREATE TABLE "work_task" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "plan_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "title" character varying(64) COLLATE "C" NOT NULL,
  "assignee_id" uuid,
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'todo',
  "progress" integer NOT NULL DEFAULT 0,
  "plan_start" timestamp with time zone,
  "plan_end" timestamp with time zone,
  "note" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_work_task_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_work_task_tenant_id_plan_id" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "work_plan" ("tenant_id", "id"),
  CONSTRAINT "fk_work_task_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_work_task_tenant_id_plan_id" ON "work_task" ("tenant_id", "plan_id");

CREATE INDEX "idx_work_task_tenant_id_project_id_status" ON "work_task" ("tenant_id", "project_id", "status");

CREATE INDEX "idx_work_task_tenant_id_assignee_id" ON "work_task" ("tenant_id", "assignee_id");

CREATE INDEX "idx_work_task_tenant_id_created_at_id" ON "work_task" ("tenant_id", "created_at", "id");

CREATE TABLE "progress_log" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "reporter_id" uuid,
  "progress" integer NOT NULL,
  "content" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_progress_log_tenant_id_task_id" FOREIGN KEY ("tenant_id", "task_id") REFERENCES "work_task" ("tenant_id", "id"),
  CONSTRAINT "fk_progress_log_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_progress_log_tenant_id_task_id_at" ON "progress_log" ("tenant_id", "task_id", "at");

CREATE INDEX "idx_progress_log_tenant_id_project_id_at" ON "progress_log" ("tenant_id", "project_id", "at");

CREATE INDEX "idx_progress_log_tenant_id_created_at_id" ON "progress_log" ("tenant_id", "created_at", "id");

CREATE TABLE "material_issue" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "applicant_id" uuid,
  "amount" numeric(18,2) NOT NULL DEFAULT 0.00,
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'draft',
  "approval_instance_id" uuid,
  "error_message" text COLLATE "C",
  "note" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_material_issue_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_material_issue_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id"),
  CONSTRAINT "fk_material_issue_tenant_id_warehouse_id" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouse" ("tenant_id", "id")
);

CREATE INDEX "idx_material_issue_tenant_id_project_id" ON "material_issue" ("tenant_id", "project_id");

CREATE INDEX "idx_material_issue_tenant_id_warehouse_id" ON "material_issue" ("tenant_id", "warehouse_id");

CREATE INDEX "idx_material_issue_tenant_id_status" ON "material_issue" ("tenant_id", "status");

CREATE INDEX "idx_material_issue_tenant_id_created_at_id" ON "material_issue" ("tenant_id", "created_at", "id");

CREATE TABLE "material_issue_line" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "qty" numeric(18,2) NOT NULL,
  "unit_cost" numeric(18,2),
  "note" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_material_issue_line_tenant_id_issue_id" FOREIGN KEY ("tenant_id", "issue_id") REFERENCES "material_issue" ("tenant_id", "id"),
  CONSTRAINT "fk_material_issue_line_tenant_id_item_id" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "item" ("tenant_id", "id")
);

CREATE INDEX "idx_material_issue_line_tenant_id_issue_id" ON "material_issue_line" ("tenant_id", "issue_id");

CREATE INDEX "idx_material_issue_line_tenant_id_item_id" ON "material_issue_line" ("tenant_id", "item_id");

CREATE INDEX "idx_material_issue_line_tenant_id_issue_id_created_at" ON "material_issue_line" ("tenant_id", "issue_id", "created_at");

CREATE TABLE "change_order" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "title" character varying(64) COLLATE "C" NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  "reason" text COLLATE "C",
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'draft',
  "approval_instance_id" uuid,
  "applied_at" timestamp with time zone,
  "error_message" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_change_order_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_change_order_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_change_order_tenant_id_project_id" ON "change_order" ("tenant_id", "project_id");

CREATE INDEX "idx_change_order_tenant_id_status" ON "change_order" ("tenant_id", "status");

CREATE INDEX "idx_change_order_tenant_id_created_at_id" ON "change_order" ("tenant_id", "created_at", "id");

CREATE TABLE "acceptance" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "type" character varying(64) COLLATE "C" NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'draft',
  "items" jsonb NOT NULL,
  "conclusion" text COLLATE "C",
  "accepted_by" uuid,
  "accepted_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_acceptance_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_acceptance_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_acceptance_tenant_id_project_id" ON "acceptance" ("tenant_id", "project_id");

CREATE INDEX "idx_acceptance_tenant_id_type_status" ON "acceptance" ("tenant_id", "type", "status");

CREATE INDEX "idx_acceptance_tenant_id_created_at_id" ON "acceptance" ("tenant_id", "created_at", "id");

CREATE TABLE "labor_hour" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "task_id" uuid,
  "user_id" uuid NOT NULL,
  "work_date" timestamp with time zone NOT NULL,
  "hours" numeric(18,2) NOT NULL,
  "note" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_labor_hour_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id"),
  CONSTRAINT "fk_labor_hour_tenant_id_task_id" FOREIGN KEY ("tenant_id", "task_id") REFERENCES "work_task" ("tenant_id", "id")
);

CREATE INDEX "idx_labor_hour_tenant_id_project_id_work_date" ON "labor_hour" ("tenant_id", "project_id", "work_date");

CREATE INDEX "idx_labor_hour_tenant_id_user_id" ON "labor_hour" ("tenant_id", "user_id");

CREATE INDEX "idx_labor_hour_tenant_id_task_id" ON "labor_hour" ("tenant_id", "task_id");

CREATE INDEX "idx_labor_hour_tenant_id_created_at_id" ON "labor_hour" ("tenant_id", "created_at", "id");

CREATE TABLE "site_record" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "author_id" uuid,
  "recorded_at" timestamp with time zone NOT NULL,
  "weather" character varying(64) COLLATE "C",
  "content" text COLLATE "C" NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_site_record_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_site_record_tenant_id_project_id_recorded_at" ON "site_record" ("tenant_id", "project_id", "recorded_at");

CREATE INDEX "idx_site_record_tenant_id_created_at_id" ON "site_record" ("tenant_id", "created_at", "id");
