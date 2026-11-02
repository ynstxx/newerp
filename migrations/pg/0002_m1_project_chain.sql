-- 0002_m1_project_chain · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 22 · 语句 34 · 2026-11-02T06:47:59.965Z

CREATE TABLE "opportunity" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "party_id" uuid NOT NULL,
  "owner_id" uuid,
  "stage" character varying(64) COLLATE "C" NOT NULL,
  "est_amount" numeric(18,2) NOT NULL,
  "expected_sign_at" timestamp with time zone,
  "note" text COLLATE "C",
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_opportunity_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_opportunity_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id")
);

CREATE INDEX "idx_opportunity_tenant_id_party_id" ON "opportunity" ("tenant_id", "party_id");

CREATE INDEX "idx_opportunity_tenant_id_stage" ON "opportunity" ("tenant_id", "stage");

CREATE INDEX "idx_opportunity_tenant_id_owner_id" ON "opportunity" ("tenant_id", "owner_id");

CREATE TABLE "project" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "party_id" uuid NOT NULL,
  "opportunity_id" uuid,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "contract_amt" numeric(18,2) NOT NULL,
  "pm_user_id" uuid,
  "start_date" timestamp with time zone,
  "end_date" timestamp with time zone,
  "note" text COLLATE "C",
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "version" integer NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_project_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_project_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id"),
  CONSTRAINT "fk_project_tenant_id_opportunity_id" FOREIGN KEY ("tenant_id", "opportunity_id") REFERENCES "opportunity" ("tenant_id", "id")
);

CREATE INDEX "idx_project_tenant_id_party_id" ON "project" ("tenant_id", "party_id");

CREATE INDEX "idx_project_tenant_id_status" ON "project" ("tenant_id", "status");

CREATE INDEX "idx_project_tenant_id_opportunity_id" ON "project" ("tenant_id", "opportunity_id");

CREATE INDEX "idx_project_tenant_id_pm_user_id" ON "project" ("tenant_id", "pm_user_id");

CREATE TABLE "project_stage_log" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "from_status" character varying(64) COLLATE "C",
  "to_status" character varying(64) COLLATE "C" NOT NULL,
  "actor_id" uuid,
  "note" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_project_stage_log_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_project_stage_log_tenant_id_project_id_at" ON "project_stage_log" ("tenant_id", "project_id", "at");

CREATE TABLE "requirement" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "title" character varying(64) COLLATE "C" NOT NULL,
  "content" text COLLATE "C",
  "status" character varying(64) COLLATE "C" NOT NULL,
  "confirmed_by" uuid,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_requirement_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_requirement_tenant_id_project_id" ON "requirement" ("tenant_id", "project_id");

CREATE INDEX "idx_requirement_tenant_id_status" ON "requirement" ("tenant_id", "status");

CREATE TABLE "design_doc" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "title" character varying(64) COLLATE "C" NOT NULL,
  "version" integer NOT NULL,
  "content" text COLLATE "C",
  "status" character varying(64) COLLATE "C" NOT NULL,
  "confirmed_by" uuid,
  "confirmed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_design_doc_tenant_id_project_id_version" UNIQUE ("tenant_id", "project_id", "version"),
  CONSTRAINT "fk_design_doc_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_design_doc_tenant_id_project_id" ON "design_doc" ("tenant_id", "project_id");

CREATE INDEX "idx_design_doc_tenant_id_status" ON "design_doc" ("tenant_id", "status");

CREATE TABLE "bom_line" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "design_doc_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "item_name" character varying(64) COLLATE "C" NOT NULL,
  "spec" character varying(64) COLLATE "C",
  "uom" character varying(64) COLLATE "C",
  "qty" numeric(18,2) NOT NULL,
  "unit_cost" numeric(18,2) NOT NULL,
  "note" text COLLATE "C",
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_bom_line_tenant_id_design_doc_id_line_no" UNIQUE ("tenant_id", "design_doc_id", "line_no"),
  CONSTRAINT "fk_bom_line_tenant_id_design_doc_id" FOREIGN KEY ("tenant_id", "design_doc_id") REFERENCES "design_doc" ("tenant_id", "id")
);

CREATE INDEX "idx_bom_line_tenant_id_design_doc_id" ON "bom_line" ("tenant_id", "design_doc_id");

CREATE TABLE "quotation" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "version" integer NOT NULL,
  "party_id" uuid NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  "valid_until" timestamp with time zone,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "sent_at" timestamp with time zone,
  "decided_at" timestamp with time zone,
  "note" text COLLATE "C",
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_quotation_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_quotation_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id"),
  CONSTRAINT "fk_quotation_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id")
);

CREATE INDEX "idx_quotation_tenant_id_project_id" ON "quotation" ("tenant_id", "project_id");

CREATE INDEX "idx_quotation_tenant_id_party_id" ON "quotation" ("tenant_id", "party_id");

CREATE INDEX "idx_quotation_tenant_id_status" ON "quotation" ("tenant_id", "status");

CREATE TABLE "quotation_line" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "quotation_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "item_name" character varying(64) COLLATE "C" NOT NULL,
  "spec" character varying(64) COLLATE "C",
  "uom" character varying(64) COLLATE "C",
  "qty" numeric(18,2) NOT NULL,
  "price" numeric(18,2) NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  "note" text COLLATE "C",
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_quotation_line_tenant_id_quotation_id_line_no" UNIQUE ("tenant_id", "quotation_id", "line_no"),
  CONSTRAINT "fk_quotation_line_tenant_id_quotation_id" FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotation" ("tenant_id", "id")
);

CREATE INDEX "idx_quotation_line_tenant_id_quotation_id" ON "quotation_line" ("tenant_id", "quotation_id");

CREATE TABLE "contract" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "quotation_id" uuid,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "party_id" uuid NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  "sign_at" timestamp with time zone,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "note" text COLLATE "C",
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_contract_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_contract_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id"),
  CONSTRAINT "fk_contract_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id"),
  CONSTRAINT "fk_contract_tenant_id_quotation_id" FOREIGN KEY ("tenant_id", "quotation_id") REFERENCES "quotation" ("tenant_id", "id")
);

CREATE INDEX "idx_contract_tenant_id_project_id" ON "contract" ("tenant_id", "project_id");

CREATE INDEX "idx_contract_tenant_id_party_id" ON "contract" ("tenant_id", "party_id");

CREATE INDEX "idx_contract_tenant_id_status" ON "contract" ("tenant_id", "status");

CREATE INDEX "idx_contract_tenant_id_quotation_id" ON "contract" ("tenant_id", "quotation_id");

CREATE TABLE "contract_line" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "contract_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "item_name" character varying(64) COLLATE "C" NOT NULL,
  "spec" character varying(64) COLLATE "C",
  "uom" character varying(64) COLLATE "C",
  "qty" numeric(18,2) NOT NULL,
  "price" numeric(18,2) NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_contract_line_tenant_id_contract_id_line_no" UNIQUE ("tenant_id", "contract_id", "line_no"),
  CONSTRAINT "fk_contract_line_tenant_id_contract_id" FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "contract" ("tenant_id", "id")
);

CREATE INDEX "idx_contract_line_tenant_id_contract_id" ON "contract_line" ("tenant_id", "contract_id");

CREATE TABLE "contract_term" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "contract_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "title" character varying(64) COLLATE "C" NOT NULL,
  "content" text COLLATE "C" NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_contract_term_tenant_id_contract_id_seq" UNIQUE ("tenant_id", "contract_id", "seq"),
  CONSTRAINT "fk_contract_term_tenant_id_contract_id" FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "contract" ("tenant_id", "id")
);

CREATE INDEX "idx_contract_term_tenant_id_contract_id" ON "contract_term" ("tenant_id", "contract_id");
