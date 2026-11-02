-- 0003_m1_locks_and_indexes · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 22 · 语句 9 · 2026-11-02T07:59:10.464Z

CREATE INDEX "idx_party_tenant_id_created_at_id" ON "party" ("tenant_id", "created_at", "id");

CREATE INDEX "idx_opportunity_tenant_id_created_at_id" ON "opportunity" ("tenant_id", "created_at", "id");

CREATE INDEX "idx_project_tenant_id_created_at_id" ON "project" ("tenant_id", "created_at", "id");

ALTER TABLE "requirement" ADD COLUMN "version" integer NOT NULL DEFAULT 1;

CREATE INDEX "idx_requirement_tenant_id_created_at_id" ON "requirement" ("tenant_id", "created_at", "id");

ALTER TABLE "design_doc" ADD COLUMN "lock_version" integer NOT NULL DEFAULT 1;

CREATE INDEX "idx_design_doc_tenant_id_created_at_id" ON "design_doc" ("tenant_id", "created_at", "id");

CREATE INDEX "idx_quotation_tenant_id_created_at_id" ON "quotation" ("tenant_id", "created_at", "id");

CREATE INDEX "idx_contract_tenant_id_created_at_id" ON "contract" ("tenant_id", "created_at", "id");
