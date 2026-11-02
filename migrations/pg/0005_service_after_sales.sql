-- 0005_service_after_sales · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 37 · 语句 28 · 2026-11-02T08:18:42.192Z

CREATE TABLE "service_contract" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "party_id" uuid NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "start_at" timestamp with time zone,
  "end_at" timestamp with time zone,
  "sla_level" character varying(64) COLLATE "C" NOT NULL DEFAULT 'P2',
  "response_minutes" integer NOT NULL DEFAULT 60,
  "resolve_minutes" integer NOT NULL DEFAULT 480,
  "amount" numeric(18,2) NOT NULL DEFAULT 0.00,
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'active',
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_service_contract_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_service_contract_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id")
);

CREATE INDEX "idx_service_contract_tenant_id_party_id" ON "service_contract" ("tenant_id", "party_id");

CREATE INDEX "idx_service_contract_tenant_id_status" ON "service_contract" ("tenant_id", "status");

CREATE INDEX "idx_service_contract_tenant_id_created_at_id" ON "service_contract" ("tenant_id", "created_at", "id");

CREATE TABLE "ticket" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "contract_id" uuid,
  "party_id" uuid NOT NULL,
  "title" character varying(64) COLLATE "C" NOT NULL,
  "content" text COLLATE "C",
  "sn" character varying(64) COLLATE "C",
  "priority" character varying(64) COLLATE "C" NOT NULL DEFAULT 'normal',
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT '待受理',
  "assignee_id" uuid,
  "reported_at" timestamp with time zone NOT NULL,
  "responded_at" timestamp with time zone,
  "resolved_at" timestamp with time zone,
  "sla_due_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_ticket_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_ticket_tenant_id_contract_id" FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "service_contract" ("tenant_id", "id"),
  CONSTRAINT "fk_ticket_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id")
);

CREATE INDEX "idx_ticket_tenant_id_contract_id" ON "ticket" ("tenant_id", "contract_id");

CREATE INDEX "idx_ticket_tenant_id_party_id" ON "ticket" ("tenant_id", "party_id");

CREATE INDEX "idx_ticket_tenant_id_status" ON "ticket" ("tenant_id", "status");

CREATE INDEX "idx_ticket_tenant_id_priority" ON "ticket" ("tenant_id", "priority");

CREATE INDEX "idx_ticket_tenant_id_sn" ON "ticket" ("tenant_id", "sn");

CREATE INDEX "idx_ticket_tenant_id_assignee_id" ON "ticket" ("tenant_id", "assignee_id");

CREATE INDEX "idx_ticket_tenant_id_created_at_id" ON "ticket" ("tenant_id", "created_at", "id");

CREATE TABLE "ticket_event" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "actor_id" uuid,
  "action" character varying(64) COLLATE "C" NOT NULL,
  "comment" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_ticket_event_tenant_id_ticket_id" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "ticket" ("tenant_id", "id")
);

CREATE INDEX "idx_ticket_event_tenant_id_ticket_id_at" ON "ticket_event" ("tenant_id", "ticket_id", "at");

CREATE TABLE "dispatch" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "engineer_id" uuid NOT NULL,
  "assigned_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "note" text COLLATE "C",
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_dispatch_tenant_id_ticket_id" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "ticket" ("tenant_id", "id")
);

CREATE INDEX "idx_dispatch_tenant_id_ticket_id" ON "dispatch" ("tenant_id", "ticket_id");

CREATE INDEX "idx_dispatch_tenant_id_engineer_id" ON "dispatch" ("tenant_id", "engineer_id");

CREATE TABLE "maintenance_plan" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "contract_id" uuid NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "cron_note" character varying(64) COLLATE "C",
  "next_at" timestamp with time zone,
  "enabled" boolean NOT NULL DEFAULT TRUE,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_maintenance_plan_tenant_id_contract_id" FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "service_contract" ("tenant_id", "id")
);

CREATE INDEX "idx_maintenance_plan_tenant_id_contract_id" ON "maintenance_plan" ("tenant_id", "contract_id");

CREATE INDEX "idx_maintenance_plan_tenant_id_next_at" ON "maintenance_plan" ("tenant_id", "next_at");

CREATE INDEX "idx_maintenance_plan_tenant_id_created_at_id" ON "maintenance_plan" ("tenant_id", "created_at", "id");

CREATE TABLE "maintenance_task" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "plan_id" uuid NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "done_at" timestamp with time zone,
  "result" text COLLATE "C",
  "assignee_id" uuid,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_maintenance_task_tenant_id_plan_id" FOREIGN KEY ("tenant_id", "plan_id") REFERENCES "maintenance_plan" ("tenant_id", "id")
);

CREATE INDEX "idx_maintenance_task_tenant_id_plan_id_due_at" ON "maintenance_task" ("tenant_id", "plan_id", "due_at");

CREATE INDEX "idx_maintenance_task_tenant_id_done_at" ON "maintenance_task" ("tenant_id", "done_at");

CREATE TABLE "spare_part_move" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "item_name" character varying(64) COLLATE "C" NOT NULL,
  "qty" numeric(18,2) NOT NULL,
  "dir" character varying(64) COLLATE "C" NOT NULL,
  "note" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_spare_part_move_tenant_id_ticket_id" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "ticket" ("tenant_id", "id")
);

CREATE INDEX "idx_spare_part_move_tenant_id_ticket_id_at" ON "spare_part_move" ("tenant_id", "ticket_id", "at");

CREATE TABLE "satisfaction" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "ticket_id" uuid NOT NULL,
  "score" integer NOT NULL,
  "comment" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_satisfaction_tenant_id_ticket_id" FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "ticket" ("tenant_id", "id")
);

CREATE INDEX "idx_satisfaction_tenant_id_ticket_id_at" ON "satisfaction" ("tenant_id", "ticket_id", "at");
