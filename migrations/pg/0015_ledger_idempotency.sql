-- 0015_ledger_idempotency · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 75 · 语句 2 · 2026-11-02T11:11:56.689Z

ALTER TABLE "ar_ledger" ADD CONSTRAINT "uq_ar_ledger_tenant_id_entry_type_ref_type_ref_id" UNIQUE ("tenant_id", "entry_type", "ref_type", "ref_id");

ALTER TABLE "ap_ledger" ADD CONSTRAINT "uq_ap_ledger_tenant_id_entry_type_ref_type_ref_id" UNIQUE ("tenant_id", "entry_type", "ref_type", "ref_id");
