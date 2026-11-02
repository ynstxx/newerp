-- 0010_purchase_finance · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 64 · 语句 57 · 2026-11-02T08:34:33.935Z

CREATE TABLE "purchase_order" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid,
  "party_id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "amount" numeric(18,2) NOT NULL DEFAULT 0.00,
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'draft',
  "note" text COLLATE "C",
  "approved_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_purchase_order_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_purchase_order_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id"),
  CONSTRAINT "fk_purchase_order_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id")
);

CREATE INDEX "idx_purchase_order_tenant_id_project_id" ON "purchase_order" ("tenant_id", "project_id");

CREATE INDEX "idx_purchase_order_tenant_id_party_id" ON "purchase_order" ("tenant_id", "party_id");

CREATE INDEX "idx_purchase_order_tenant_id_status" ON "purchase_order" ("tenant_id", "status");

CREATE INDEX "idx_purchase_order_tenant_id_created_at_id" ON "purchase_order" ("tenant_id", "created_at", "id");

CREATE TABLE "po_line" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "po_id" uuid NOT NULL,
  "line_no" integer NOT NULL,
  "item_id" uuid NOT NULL,
  "qty" numeric(18,2) NOT NULL,
  "price" numeric(18,2) NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_po_line_tenant_id_po_id_line_no" UNIQUE ("tenant_id", "po_id", "line_no"),
  CONSTRAINT "fk_po_line_tenant_id_po_id" FOREIGN KEY ("tenant_id", "po_id") REFERENCES "purchase_order" ("tenant_id", "id"),
  CONSTRAINT "fk_po_line_tenant_id_item_id" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "item" ("tenant_id", "id")
);

CREATE INDEX "idx_po_line_tenant_id_po_id" ON "po_line" ("tenant_id", "po_id");

CREATE INDEX "idx_po_line_tenant_id_item_id" ON "po_line" ("tenant_id", "item_id");

CREATE TABLE "goods_receipt" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "po_id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'posted',
  "received_at" timestamp with time zone NOT NULL,
  "note" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 1,
  "received_by" uuid,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_goods_receipt_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_goods_receipt_tenant_id_po_id" FOREIGN KEY ("tenant_id", "po_id") REFERENCES "purchase_order" ("tenant_id", "id"),
  CONSTRAINT "fk_goods_receipt_tenant_id_warehouse_id" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouse" ("tenant_id", "id")
);

CREATE INDEX "idx_goods_receipt_tenant_id_po_id" ON "goods_receipt" ("tenant_id", "po_id");

CREATE INDEX "idx_goods_receipt_tenant_id_warehouse_id" ON "goods_receipt" ("tenant_id", "warehouse_id");

CREATE INDEX "idx_goods_receipt_tenant_id_status" ON "goods_receipt" ("tenant_id", "status");

CREATE INDEX "idx_goods_receipt_tenant_id_created_at_id" ON "goods_receipt" ("tenant_id", "created_at", "id");

CREATE TABLE "grn_line" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "receipt_id" uuid NOT NULL,
  "po_line_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "qty" numeric(18,2) NOT NULL,
  "price" numeric(18,2) NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_grn_line_tenant_id_receipt_id" FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "goods_receipt" ("tenant_id", "id"),
  CONSTRAINT "fk_grn_line_tenant_id_po_line_id" FOREIGN KEY ("tenant_id", "po_line_id") REFERENCES "po_line" ("tenant_id", "id"),
  CONSTRAINT "fk_grn_line_tenant_id_item_id" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "item" ("tenant_id", "id")
);

CREATE INDEX "idx_grn_line_tenant_id_receipt_id" ON "grn_line" ("tenant_id", "receipt_id");

CREATE INDEX "idx_grn_line_tenant_id_po_line_id" ON "grn_line" ("tenant_id", "po_line_id");

CREATE INDEX "idx_grn_line_tenant_id_item_id" ON "grn_line" ("tenant_id", "item_id");

CREATE TABLE "subcontract" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "party_id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "amount" numeric(18,2) NOT NULL DEFAULT 0.00,
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'draft',
  "note" text COLLATE "C",
  "approved_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_subcontract_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_subcontract_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id"),
  CONSTRAINT "fk_subcontract_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id")
);

CREATE INDEX "idx_subcontract_tenant_id_project_id" ON "subcontract" ("tenant_id", "project_id");

CREATE INDEX "idx_subcontract_tenant_id_party_id" ON "subcontract" ("tenant_id", "party_id");

CREATE INDEX "idx_subcontract_tenant_id_status" ON "subcontract" ("tenant_id", "status");

CREATE INDEX "idx_subcontract_tenant_id_created_at_id" ON "subcontract" ("tenant_id", "created_at", "id");

CREATE TABLE "subcontract_progress" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "subcontract_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'draft',
  "note" text COLLATE "C",
  "approved_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_subcontract_progress_tenant_id_subcontract_id_seq" UNIQUE ("tenant_id", "subcontract_id", "seq"),
  CONSTRAINT "fk_subcontract_progress_tenant_id_subcontract_id" FOREIGN KEY ("tenant_id", "subcontract_id") REFERENCES "subcontract" ("tenant_id", "id")
);

CREATE INDEX "idx_subcontract_progress_tenant_id_subcontract_id" ON "subcontract_progress" ("tenant_id", "subcontract_id");

CREATE INDEX "idx_subcontract_progress_tenant_id_status" ON "subcontract_progress" ("tenant_id", "status");

CREATE INDEX "idx_subcontract_progress_tenant_id_created_at_id" ON "subcontract_progress" ("tenant_id", "created_at", "id");

CREATE TABLE "invoice" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "kind" character varying(64) COLLATE "C" NOT NULL,
  "party_id" uuid NOT NULL,
  "project_id" uuid,
  "contract_id" uuid,
  "po_id" uuid,
  "subcontract_id" uuid,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL DEFAULT 'issued',
  "issued_at" timestamp with time zone NOT NULL,
  "note" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_invoice_tenant_id_code" UNIQUE ("tenant_id", "code"),
  CONSTRAINT "fk_invoice_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id"),
  CONSTRAINT "fk_invoice_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id"),
  CONSTRAINT "fk_invoice_tenant_id_contract_id" FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "contract" ("tenant_id", "id"),
  CONSTRAINT "fk_invoice_tenant_id_po_id" FOREIGN KEY ("tenant_id", "po_id") REFERENCES "purchase_order" ("tenant_id", "id"),
  CONSTRAINT "fk_invoice_tenant_id_subcontract_id" FOREIGN KEY ("tenant_id", "subcontract_id") REFERENCES "subcontract" ("tenant_id", "id")
);

CREATE INDEX "idx_invoice_tenant_id_kind_status" ON "invoice" ("tenant_id", "kind", "status");

CREATE INDEX "idx_invoice_tenant_id_party_id" ON "invoice" ("tenant_id", "party_id");

CREATE INDEX "idx_invoice_tenant_id_project_id" ON "invoice" ("tenant_id", "project_id");

CREATE INDEX "idx_invoice_tenant_id_contract_id" ON "invoice" ("tenant_id", "contract_id");

CREATE INDEX "idx_invoice_tenant_id_created_at_id" ON "invoice" ("tenant_id", "created_at", "id");

CREATE TABLE "ar_ledger" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "party_id" uuid NOT NULL,
  "project_id" uuid,
  "contract_id" uuid,
  "invoice_id" uuid,
  "entry_type" character varying(64) COLLATE "C" NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  "ref_type" character varying(64) COLLATE "C",
  "ref_id" uuid,
  "note" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_ar_ledger_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id"),
  CONSTRAINT "fk_ar_ledger_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id"),
  CONSTRAINT "fk_ar_ledger_tenant_id_contract_id" FOREIGN KEY ("tenant_id", "contract_id") REFERENCES "contract" ("tenant_id", "id"),
  CONSTRAINT "fk_ar_ledger_tenant_id_invoice_id" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoice" ("tenant_id", "id")
);

CREATE INDEX "idx_ar_ledger_tenant_id_party_id" ON "ar_ledger" ("tenant_id", "party_id");

CREATE INDEX "idx_ar_ledger_tenant_id_project_id" ON "ar_ledger" ("tenant_id", "project_id");

CREATE INDEX "idx_ar_ledger_tenant_id_contract_id" ON "ar_ledger" ("tenant_id", "contract_id");

CREATE INDEX "idx_ar_ledger_tenant_id_at_id" ON "ar_ledger" ("tenant_id", "at", "id");

CREATE INDEX "idx_ar_ledger_tenant_id_created_at_id" ON "ar_ledger" ("tenant_id", "created_at", "id");

CREATE TABLE "ap_ledger" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "party_id" uuid NOT NULL,
  "project_id" uuid,
  "po_id" uuid,
  "subcontract_id" uuid,
  "invoice_id" uuid,
  "entry_type" character varying(64) COLLATE "C" NOT NULL,
  "amount" numeric(18,2) NOT NULL,
  "ref_type" character varying(64) COLLATE "C",
  "ref_id" uuid,
  "note" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_ap_ledger_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id"),
  CONSTRAINT "fk_ap_ledger_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id"),
  CONSTRAINT "fk_ap_ledger_tenant_id_po_id" FOREIGN KEY ("tenant_id", "po_id") REFERENCES "purchase_order" ("tenant_id", "id"),
  CONSTRAINT "fk_ap_ledger_tenant_id_subcontract_id" FOREIGN KEY ("tenant_id", "subcontract_id") REFERENCES "subcontract" ("tenant_id", "id"),
  CONSTRAINT "fk_ap_ledger_tenant_id_invoice_id" FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoice" ("tenant_id", "id")
);

CREATE INDEX "idx_ap_ledger_tenant_id_party_id" ON "ap_ledger" ("tenant_id", "party_id");

CREATE INDEX "idx_ap_ledger_tenant_id_project_id" ON "ap_ledger" ("tenant_id", "project_id");

CREATE INDEX "idx_ap_ledger_tenant_id_po_id" ON "ap_ledger" ("tenant_id", "po_id");

CREATE INDEX "idx_ap_ledger_tenant_id_subcontract_id" ON "ap_ledger" ("tenant_id", "subcontract_id");

CREATE INDEX "idx_ap_ledger_tenant_id_at_id" ON "ap_ledger" ("tenant_id", "at", "id");

CREATE INDEX "idx_ap_ledger_tenant_id_created_at_id" ON "ap_ledger" ("tenant_id", "created_at", "id");

CREATE TABLE "payment" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "kind" character varying(64) COLLATE "C" NOT NULL,
  "party_id" uuid NOT NULL,
  "project_id" uuid,
  "amount" numeric(18,2) NOT NULL,
  "method" character varying(64) COLLATE "C" NOT NULL DEFAULT 'bank',
  "paid_at" timestamp with time zone NOT NULL,
  "note" text COLLATE "C",
  "version" integer NOT NULL DEFAULT 1,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_payment_tenant_id_party_id" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "party" ("tenant_id", "id"),
  CONSTRAINT "fk_payment_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_payment_tenant_id_kind_party_id" ON "payment" ("tenant_id", "kind", "party_id");

CREATE INDEX "idx_payment_tenant_id_party_id" ON "payment" ("tenant_id", "party_id");

CREATE INDEX "idx_payment_tenant_id_project_id" ON "payment" ("tenant_id", "project_id");

CREATE INDEX "idx_payment_tenant_id_paid_at" ON "payment" ("tenant_id", "paid_at");

CREATE INDEX "idx_payment_tenant_id_created_at_id" ON "payment" ("tenant_id", "created_at", "id");

CREATE TABLE "cost_line" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "source" character varying(64) COLLATE "C" NOT NULL,
  "ref_type" character varying(64) COLLATE "C",
  "ref_id" uuid,
  "amount" numeric(18,2) NOT NULL,
  "note" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_cost_line_tenant_id_project_id" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project" ("tenant_id", "id")
);

CREATE INDEX "idx_cost_line_tenant_id_project_id" ON "cost_line" ("tenant_id", "project_id");

CREATE INDEX "idx_cost_line_tenant_id_source" ON "cost_line" ("tenant_id", "source");

CREATE INDEX "idx_cost_line_tenant_id_ref_type_ref_id" ON "cost_line" ("tenant_id", "ref_type", "ref_id");

CREATE INDEX "idx_cost_line_tenant_id_at_id" ON "cost_line" ("tenant_id", "at", "id");

CREATE INDEX "idx_cost_line_tenant_id_created_at_id" ON "cost_line" ("tenant_id", "created_at", "id");
