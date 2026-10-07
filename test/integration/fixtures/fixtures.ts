import type { Client } from 'pg';

/**
 * DDL for DuckLake metastore tables as expected by DuckDB ducklake extension
 * and ducklake-sql-assistant catalog introspection queries.
 */
export const DUCKLAKE_METASTORE_DDL = `
-- 1. Schema catalog
CREATE TABLE IF NOT EXISTS ducklake_schema (
  schema_id BIGINT PRIMARY KEY,
  schema_uuid UUID,
  begin_snapshot BIGINT,
  end_snapshot BIGINT,
  schema_name VARCHAR NOT NULL,
  path VARCHAR,
  path_is_relative BOOLEAN
);

-- 2. Table catalog
CREATE TABLE IF NOT EXISTS ducklake_table (
  table_id BIGINT PRIMARY KEY,
  table_uuid UUID,
  begin_snapshot BIGINT,
  end_snapshot BIGINT,
  schema_id BIGINT REFERENCES ducklake_schema(schema_id),
  table_name VARCHAR NOT NULL,
  path VARCHAR,
  path_is_relative BOOLEAN
);

-- 3. Column catalog
CREATE TABLE IF NOT EXISTS ducklake_column (
  column_id BIGINT PRIMARY KEY,
  begin_snapshot BIGINT,
  end_snapshot BIGINT,
  table_id BIGINT REFERENCES ducklake_table(table_id),
  column_order BIGINT,
  column_name VARCHAR NOT NULL,
  column_type VARCHAR NOT NULL,
  initial_default VARCHAR,
  default_value VARCHAR,
  nulls_allowed BOOLEAN,
  parent_column BIGINT,
  default_value_type VARCHAR,
  default_value_dialect VARCHAR
);

-- 4. View catalog
CREATE TABLE IF NOT EXISTS ducklake_view (
  view_id BIGINT PRIMARY KEY,
  view_uuid UUID,
  begin_snapshot BIGINT,
  end_snapshot BIGINT,
  schema_id BIGINT REFERENCES ducklake_schema(schema_id),
  view_name VARCHAR NOT NULL,
  dialect VARCHAR,
  sql VARCHAR,
  column_aliases VARCHAR
);

-- 5. Table statistics
CREATE TABLE IF NOT EXISTS ducklake_table_stats (
  table_id BIGINT PRIMARY KEY REFERENCES ducklake_table(table_id),
  record_count BIGINT,
  next_row_id BIGINT,
  file_size_bytes BIGINT
);

-- 6. Snapshot tracking
CREATE TABLE IF NOT EXISTS ducklake_snapshot (
  snapshot_id BIGINT PRIMARY KEY,
  snapshot_time TIMESTAMP WITH TIME ZONE,
  schema_version BIGINT,
  next_catalog_id BIGINT,
  next_file_id BIGINT
);

-- 7. Metastore header
CREATE TABLE IF NOT EXISTS ducklake_metadata (
  key VARCHAR NOT NULL,
  value VARCHAR NOT NULL,
  scope VARCHAR,
  scope_id BIGINT
);
`;

/**
 * Active DuckLake seed rows (end_snapshot IS NULL for active objects).
 */
export const DUCKLAKE_METASTORE_SEED_SQL = `
-- Clean any previous seed data idempotently
TRUNCATE TABLE ducklake_metadata CASCADE;
TRUNCATE TABLE ducklake_view CASCADE;
TRUNCATE TABLE ducklake_column CASCADE;
TRUNCATE TABLE ducklake_table_stats CASCADE;
TRUNCATE TABLE ducklake_table CASCADE;
TRUNCATE TABLE ducklake_schema CASCADE;
TRUNCATE TABLE ducklake_snapshot CASCADE;

-- Insert active schema
INSERT INTO ducklake_schema (schema_id, schema_uuid, begin_snapshot, end_snapshot, schema_name, path, path_is_relative)
VALUES (0, 'e6bcdb1c-a497-4aa4-97ba-a9b32fb8cda6', 0, NULL, 'main', 'main/', true);

-- Insert active tables
INSERT INTO ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative)
VALUES 
  (1, '01a11691-f20b-75b3-9e5e-a8616fa4b757', 1, NULL, 0, 'customers', 'customers/', true),
  (2, '02b22792-f30c-76b4-9e6f-b9727fa5c868', 1, NULL, 0, 'orders', 'orders/', true);

-- Insert active columns
INSERT INTO ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, initial_default, default_value, nulls_allowed, parent_column, default_value_type, default_value_dialect)
VALUES 
  (1, 1, NULL, 1, 1, 'customer_id', 'int32', NULL, 'NULL', false, NULL, 'literal', 'duckdb'),
  (2, 1, NULL, 1, 2, 'customer_name', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb'),
  (3, 1, NULL, 2, 1, 'order_id', 'int32', NULL, 'NULL', false, NULL, 'literal', 'duckdb'),
  (4, 1, NULL, 2, 2, 'customer_id', 'int32', NULL, 'NULL', false, NULL, 'literal', 'duckdb'),
  (5, 1, NULL, 2, 3, 'order_total', 'numeric(10,2)', NULL, 'NULL', true, NULL, 'literal', 'duckdb');

-- Insert table stats
INSERT INTO ducklake_table_stats (table_id, record_count, next_row_id, file_size_bytes)
VALUES 
  (1, 500, 501, 102400),
  (2, 1250, 1251, 256000);

-- Insert active view
INSERT INTO ducklake_view (view_id, view_uuid, begin_snapshot, end_snapshot, schema_id, view_name, dialect, sql, column_aliases)
VALUES (1, '11111111-2222-3333-4444-555555555555', 1, NULL, 0, 'v_customers', 'duckdb', 'SELECT * FROM main.customers', NULL);

-- Insert snapshot
INSERT INTO ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id)
VALUES (1, CURRENT_TIMESTAMP, 1, 3, 3);

-- Insert metadata
INSERT INTO ducklake_metadata (key, value, scope, scope_id)
VALUES 
  ('version', '1', 'global', 0),
  ('data_path', 'test/data', 'global', 0);
`;

/**
 * Native PostgreSQL tables with Thai characters in names, columns, and comments.
 */
export const THAI_TABLES_DDL = `
DROP TABLE IF EXISTS "คำสั่งซื้อ" CASCADE;
DROP TABLE IF EXISTS "ตารางลูกค้า" CASCADE;

CREATE TABLE "ตารางลูกค้า" (
  "รหัสลูกค้า" INT PRIMARY KEY,
  "ชื่อลูกค้า" VARCHAR(100),
  "ยอดสั่งซื้อ" NUMERIC(10, 2)
);
COMMENT ON TABLE "ตารางลูกค้า" IS 'ตารางลูกค้าของบริษัท';
COMMENT ON COLUMN "ตารางลูกค้า"."รหัสลูกค้า" IS 'รหัสประจำตัวลูกค้า';
COMMENT ON COLUMN "ตารางลูกค้า"."ชื่อลูกค้า" IS 'ชื่อและนามสกุลลูกค้า';
COMMENT ON COLUMN "ตารางลูกค้า"."ยอดสั่งซื้อ" IS 'ยอดสั่งซื้อสะสม';

CREATE TABLE "คำสั่งซื้อ" (
  "รหัสคำสั่งซื้อ" INT PRIMARY KEY,
  "รหัสลูกค้า" INT,
  "วันที่สั่งซื้อ" DATE,
  "จำนวนเงิน" NUMERIC(10, 2)
);
COMMENT ON TABLE "คำสั่งซื้อ" IS 'รายการคำสั่งซื้อสินค้า';
COMMENT ON COLUMN "คำสั่งซื้อ"."รหัสคำสั่งซื้อ" IS 'รหัสใบสั่งซื้อสินค้า';
COMMENT ON COLUMN "คำสั่งซื้อ"."รหัสลูกค้า" IS 'รหัสลูกค้าผู้ออกคำสั่งซื้อ';
COMMENT ON COLUMN "คำสั่งซื้อ"."วันที่สั่งซื้อ" IS 'วันที่ทำรายการ';
COMMENT ON COLUMN "คำสั่งซื้อ"."จำนวนเงิน" IS 'จำนวนเงินรวมของคำสั่งซื้อ';

-- Insert sample rows with Thai data
INSERT INTO "ตารางลูกค้า" ("รหัสลูกค้า", "ชื่อลูกค้า", "ยอดสั่งซื้อ")
VALUES 
  (1, 'สมชาย สถิต', 1500.50),
  (2, 'วิภา ประเสริฐ', 3200.00);

INSERT INTO "คำสั่งซื้อ" ("รหัสคำสั่งซื้อ", "รหัสลูกค้า", "วันที่สั่งซื้อ", "จำนวนเงิน")
VALUES 
  (101, 1, '2026-10-01', 1500.50),
  (102, 2, '2026-10-02', 3200.00);
`;

/**
 * Fault injection fixture: table with corrupt comment containing byte 0xDB (unmapped in WIN874->UTF8).
 * This will trigger PostgreSQL error 22P05 when introspected under client_encoding='UTF8'.
 */
export const CORRUPT_COMMENT_DDL = `
DROP TABLE IF EXISTS test_corrupt_comments CASCADE;

CREATE TABLE test_corrupt_comments (
  id INT PRIMARY KEY,
  note TEXT
);

-- Under SQL_ASCII, postgres stores raw byte 0xDB directly into pg_description
SET client_encoding = 'SQL_ASCII';
COMMENT ON TABLE test_corrupt_comments IS E'Corrupt Thai \\xdb comment';
COMMENT ON COLUMN test_corrupt_comments.note IS E'Corrupt column \\xdb comment';
SET client_encoding = 'WIN874';
`;

/**
 * Seeds all required fixtures (DuckLake metastore, Thai tables, corrupt comment fault table).
 */
export async function seedAllFixtures(client: Client): Promise<void> {
  // 1. DuckLake Metastore DDL
  await client.query(DUCKLAKE_METASTORE_DDL);

  // 2. DuckLake Metastore Seed Data
  await client.query(DUCKLAKE_METASTORE_SEED_SQL);

  // 3. Native Thai Tables & Comments
  await client.query(THAI_TABLES_DDL);

  // 4. Corrupt comment fixture for resilience testing
  await client.query(CORRUPT_COMMENT_DDL);
}
