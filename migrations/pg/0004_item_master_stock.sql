-- 0004_item_master_stock · pg · 由 cmd/migrate.mjs gen 生成，勿手改
-- 表数 29 · 语句 22 · 2026-11-02T08:16:20.311Z

CREATE TABLE "item" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "spec" character varying(64) COLLATE "C",
  "category" character varying(64) COLLATE "C",
  "base_uom" character varying(64) COLLATE "C" NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_item_tenant_id_code" UNIQUE ("tenant_id", "code")
);

CREATE INDEX "idx_item_tenant_id_name" ON "item" ("tenant_id", "name");

CREATE INDEX "idx_item_tenant_id_category_status" ON "item" ("tenant_id", "category", "status");

CREATE INDEX "idx_item_tenant_id_created_at_id" ON "item" ("tenant_id", "created_at", "id");

CREATE TABLE "item_uom" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "uom" character varying(64) COLLATE "C" NOT NULL,
  "ratio" numeric(18,2) NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_item_uom_tenant_id_item_id_uom" UNIQUE ("tenant_id", "item_id", "uom"),
  CONSTRAINT "fk_item_uom_tenant_id_item_id" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "item" ("tenant_id", "id")
);

CREATE INDEX "idx_item_uom_tenant_id_item_id" ON "item_uom" ("tenant_id", "item_id");

CREATE TABLE "warehouse" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "code" character varying(64) COLLATE "C" NOT NULL,
  "name" character varying(64) COLLATE "C" NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_warehouse_tenant_id_code" UNIQUE ("tenant_id", "code")
);

CREATE INDEX "idx_warehouse_tenant_id_created_at_id" ON "warehouse" ("tenant_id", "created_at", "id");

CREATE TABLE "stock_bin" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "qty" numeric(18,2) NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_stock_bin_tenant_id_warehouse_id_item_id" UNIQUE ("tenant_id", "warehouse_id", "item_id"),
  CONSTRAINT "fk_stock_bin_tenant_id_warehouse_id" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouse" ("tenant_id", "id"),
  CONSTRAINT "fk_stock_bin_tenant_id_item_id" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "item" ("tenant_id", "id")
);

CREATE INDEX "idx_stock_bin_tenant_id_item_id_warehouse_id" ON "stock_bin" ("tenant_id", "item_id", "warehouse_id");

CREATE INDEX "idx_stock_bin_tenant_id_created_at_id" ON "stock_bin" ("tenant_id", "created_at", "id");

CREATE TABLE "stock_move" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "qty" numeric(18,2) NOT NULL,
  "dir" character varying(64) COLLATE "C" NOT NULL,
  "move_type" character varying(64) COLLATE "C" NOT NULL,
  "ref_type" character varying(64) COLLATE "C",
  "ref_id" character varying(64) COLLATE "C",
  "sn_list" text COLLATE "C",
  "unit_cost" numeric(18,2),
  "note" text COLLATE "C",
  "at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_stock_move_tenant_id_warehouse_id" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouse" ("tenant_id", "id"),
  CONSTRAINT "fk_stock_move_tenant_id_item_id" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "item" ("tenant_id", "id")
);

CREATE INDEX "idx_stock_move_tenant_id_warehouse_id_item_id_at" ON "stock_move" ("tenant_id", "warehouse_id", "item_id", "at");

CREATE INDEX "idx_stock_move_tenant_id_ref_type_ref_id" ON "stock_move" ("tenant_id", "ref_type", "ref_id");

CREATE INDEX "idx_stock_move_tenant_id_at_id" ON "stock_move" ("tenant_id", "at", "id");

CREATE INDEX "idx_stock_move_tenant_id_at" ON "stock_move" ("tenant_id", "at");

CREATE TABLE "item_sn" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "sn" character varying(64) COLLATE "C" NOT NULL,
  "warehouse_id" uuid NOT NULL,
  "status" character varying(64) COLLATE "C" NOT NULL,
  "ref_type" character varying(64) COLLATE "C",
  "ref_id" character varying(64) COLLATE "C",
  "created_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "uq_item_sn_tenant_id_sn" UNIQUE ("tenant_id", "sn"),
  CONSTRAINT "fk_item_sn_tenant_id_item_id" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "item" ("tenant_id", "id"),
  CONSTRAINT "fk_item_sn_tenant_id_warehouse_id" FOREIGN KEY ("tenant_id", "warehouse_id") REFERENCES "warehouse" ("tenant_id", "id")
);

CREATE INDEX "idx_item_sn_tenant_id_item_id_warehouse_id" ON "item_sn" ("tenant_id", "item_id", "warehouse_id");

CREATE INDEX "idx_item_sn_tenant_id_created_at_id" ON "item_sn" ("tenant_id", "created_at", "id");

CREATE TABLE "price_book" (
  "tenant_id" uuid NOT NULL,
  "id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "price_type" character varying(64) COLLATE "C" NOT NULL,
  "price" numeric(18,2) NOT NULL,
  "valid_from" timestamp with time zone,
  "valid_to" timestamp with time zone,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "fk_price_book_tenant_id_item_id" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "item" ("tenant_id", "id")
);

CREATE INDEX "idx_price_book_tenant_id_item_id_price_type_valid_from" ON "price_book" ("tenant_id", "item_id", "price_type", "valid_from");

CREATE INDEX "idx_price_book_tenant_id_created_at_id" ON "price_book" ("tenant_id", "created_at", "id");
