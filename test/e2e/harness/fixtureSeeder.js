// test/e2e/harness/fixtureSeeder.js
// Seeder for DuckLake metastore schemas, Thai tables, and fault injection fixtures.

const { Client } = require('pg');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

class FixtureSeeder {
  constructor(pgConfig) {
    this.pgConfig = pgConfig;
  }

  async getClient(dbName = this.pgConfig.database) {
    const client = new Client({
      host: this.pgConfig.host,
      port: this.pgConfig.port,
      database: dbName,
      user: this.pgConfig.user,
      password: this.pgConfig.password || '',
      ssl: false
    });
    await client.connect();
    return client;
  }

  async seedAll(harness) {
    // 1. Seed primary database (ducklake_e2e) with DuckLake & native Thai tables
    await this.seedDuckLakeMetastoreViaDuckDB(harness, this.pgConfig.database);
    const client = await this.getClient(this.pgConfig.database);
    try {
      await this.seedNativeThaiTables(client);
    } finally {
      await client.end();
    }

    // 2. Seed dedicated fault injection database (ducklake_corrupt_db) for F5 & F8 resilience testing
    if (harness) {
      harness.createDatabase('ducklake_corrupt_db');
      const corruptClient = await this.getClient('ducklake_corrupt_db');
      try {
        await this.seedFaultInjectionComments(corruptClient);
      } finally {
        await corruptClient.end();
      }
    }
  }

  async seedDuckLakeMetastoreViaDuckDB(harness, dbName) {
    const tempDir = path.join(os.tmpdir(), `ducklake_e2e_data_${Date.now()}`).replace(/\\/g, '/');
    fs.mkdirSync(tempDir, { recursive: true });

    const sql = [
      'LOAD postgres;',
      'LOAD ducklake;',
      `ATTACH 'ducklake:postgres:host=127.0.0.1 port=${harness.port} dbname=${dbName} user=${harness.user} client_encoding=UTF8' AS lake (DATA_PATH '${tempDir}');`,
      'CREATE TABLE IF NOT EXISTS lake.customers (customer_id INT, customer_name VARCHAR);',
      "INSERT INTO lake.customers VALUES (1, 'Customer One'), (2, 'Customer Two');",
      'CREATE TABLE IF NOT EXISTS lake."ตารางสินค้า" ("รหัสสินค้า" INT, "ชื่อสินค้า" VARCHAR, "ราคา" DECIMAL(10,2));',
      "INSERT INTO lake.\"ตารางสินค้า\" VALUES (101, 'คอมพิวเตอร์พกพา', 25000.00), (102, 'จอภาพความละเอียดสูง', 8500.00);",
      'CREATE VIEW IF NOT EXISTS lake.v_customers AS SELECT * FROM lake.customers;'
    ].join('\n');

    const res = spawnSync('duckdb', ['-c', sql], { encoding: 'utf8' });
    if (res.status !== 0) {
      // If ducklake CLI attach encountered an issue, fallback to SQL DDL seeding
      const client = await this.getClient(dbName);
      try {
        await this.seedDuckLakeMetastoreSQL(client);
      } finally {
        await client.end();
      }
    }
  }

  async seedDuckLakeMetastoreSQL(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ducklake_schema (
        schema_id BIGINT PRIMARY KEY,
        schema_uuid UUID,
        begin_snapshot BIGINT,
        end_snapshot BIGINT,
        schema_name VARCHAR,
        path VARCHAR,
        path_is_relative BOOLEAN
      );

      CREATE TABLE IF NOT EXISTS ducklake_table (
        table_id BIGINT PRIMARY KEY,
        table_uuid UUID,
        begin_snapshot BIGINT,
        end_snapshot BIGINT,
        schema_id BIGINT REFERENCES ducklake_schema(schema_id),
        table_name VARCHAR,
        path VARCHAR,
        path_is_relative BOOLEAN
      );

      CREATE TABLE IF NOT EXISTS ducklake_column (
        column_id BIGINT PRIMARY KEY,
        begin_snapshot BIGINT,
        end_snapshot BIGINT,
        table_id BIGINT REFERENCES ducklake_table(table_id),
        column_order BIGINT,
        column_name VARCHAR,
        column_type VARCHAR,
        initial_default VARCHAR,
        default_value VARCHAR,
        nulls_allowed BOOLEAN,
        parent_column BIGINT,
        default_value_type VARCHAR,
        default_value_dialect VARCHAR
      );

      CREATE TABLE IF NOT EXISTS ducklake_view (
        view_id BIGINT PRIMARY KEY,
        view_uuid UUID,
        begin_snapshot BIGINT,
        end_snapshot BIGINT,
        schema_id BIGINT REFERENCES ducklake_schema(schema_id),
        view_name VARCHAR,
        dialect VARCHAR,
        sql VARCHAR,
        column_aliases VARCHAR
      );

      CREATE TABLE IF NOT EXISTS ducklake_table_stats (
        table_id BIGINT PRIMARY KEY REFERENCES ducklake_table(table_id),
        record_count BIGINT,
        next_row_id BIGINT,
        file_size_bytes BIGINT
      );

      DELETE FROM ducklake_view;
      DELETE FROM ducklake_table_stats;
      DELETE FROM ducklake_column;
      DELETE FROM ducklake_table;
      DELETE FROM ducklake_schema;

      INSERT INTO ducklake_schema VALUES 
        (0, 'e6bcdb1c-a497-4aa4-97ba-a9b32fb8cda6', 0, NULL, 'main', 'main/', true);

      INSERT INTO ducklake_table VALUES 
        (1, '01a11691-f20b-75b3-9e5e-a8616fa4b757', 1, NULL, 0, 'customers', 'customers/', true),
        (2, '02b22702-f31c-86c4-af6f-b9727fb5c868', 1, NULL, 0, 'ตารางสินค้า', 'products/', true);

      INSERT INTO ducklake_column VALUES 
        (1, 1, NULL, 1, 1, 'customer_id', 'int32', NULL, 'NULL', false, NULL, 'literal', 'duckdb'),
        (2, 1, NULL, 1, 2, 'customer_name', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb'),
        (3, 1, NULL, 2, 1, 'รหัสสินค้า', 'int32', NULL, 'NULL', false, NULL, 'literal', 'duckdb'),
        (4, 1, NULL, 2, 2, 'ชื่อสินค้า', 'varchar', NULL, 'NULL', true, NULL, 'literal', 'duckdb'),
        (5, 1, NULL, 2, 3, 'ราคา', 'decimal(12,2)', NULL, 'NULL', true, NULL, 'literal', 'duckdb');

      INSERT INTO ducklake_table_stats VALUES 
        (1, 500, 501, 102400),
        (2, 1200, 1201, 204800);

      INSERT INTO ducklake_view VALUES 
        (1, '11111111-2222-3333-4444-555555555555', 1, NULL, 0, 'v_customers', 'duckdb', 'SELECT * FROM main.customers', NULL),
        (2, '22222222-3333-4444-5555-666666666666', 1, NULL, 0, 'มุมมอง_สินค้า', 'duckdb', 'SELECT * FROM main."ตารางสินค้า"', NULL);
    `);
  }

  async seedNativeThaiTables(client) {
    // Drop any previously seeded corrupt tables from this database
    await client.query(`
      DROP TABLE IF EXISTS test_corrupt_comments CASCADE;
      DROP TABLE IF EXISTS test_corrupt_column_comments CASCADE;
    `);

    // 1. Customer table with Thai identifiers and comments
    await client.query(`
      DROP TABLE IF EXISTS "ตารางลูกค้า" CASCADE;
      CREATE TABLE "ตารางลูกค้า" (
        "รหัสลูกค้า" INT PRIMARY KEY,
        "ชื่อลูกค้า" VARCHAR(100) NOT NULL,
        "ที่อยู่" VARCHAR(200),
        "ยอดสั่งซื้อ" NUMERIC(10, 2) DEFAULT 0.00
      );
      COMMENT ON TABLE "ตารางลูกค้า" IS 'ข้อมูลลูกค้าภาษาไทย';
      COMMENT ON COLUMN "ตารางลูกค้า"."ชื่อลูกค้า" IS 'ชื่อและนามสกุลลูกค้า';
      COMMENT ON COLUMN "ตารางลูกค้า"."ที่อยู่" IS 'ที่อยู่สำหรับจัดส่งสินค้า';
      COMMENT ON COLUMN "ตารางลูกค้า"."ยอดสั่งซื้อ" IS 'ยอดรวมคำสั่งซื้อสะสม';

      INSERT INTO "ตารางลูกค้า" VALUES 
        (1, 'สมชาย สายลม', '123 ถนนสุขุมวิท แขวงคลองเตย กรุงเทพมหานคร', 1500.50),
        (2, 'วันดี มีสุข', '456 ถนนพหลโยธิน อำเภอเมือง เชียงใหม่', 8900.00),
        (3, 'กิตติศักดิ์ เจริญพร', '789 ถนนมิตรภาพ ขอนแก่น', 320.75);
    `);

    // 2. Orders table
    await client.query(`
      DROP TABLE IF EXISTS "คำสั่งซื้อ" CASCADE;
      CREATE TABLE "คำสั่งซื้อ" (
        "รหัสคำสั่งซื้อ" INT PRIMARY KEY,
        "รหัสลูกค้า" INT REFERENCES "ตารางลูกค้า"("รหัสลูกค้า"),
        "วันที่สั่งซื้อ" DATE,
        "สถานะ" VARCHAR(50) DEFAULT 'รอดำเนินการ'
      );
      COMMENT ON TABLE "คำสั่งซื้อ" IS 'รายการสั่งซื้อสินค้า';
      COMMENT ON COLUMN "คำสั่งซื้อ"."สถานะ" IS 'สถานะปัจจุบันของการจัดส่ง';

      INSERT INTO "คำสั่งซื้อ" VALUES 
        (101, 1, '2026-10-01', 'จัดส่งสำเร็จ'),
        (102, 2, '2026-10-02', 'กำลังจัดส่ง'),
        (103, 1, '2026-10-03', 'รอดำเนินการ');
    `);

    // 3. Tone marks and combining characters table
    await client.query(`
      DROP TABLE IF EXISTS "ข้อมูล_น้ำตาล_ผู้ใหญ่" CASCADE;
      CREATE TABLE "ข้อมูล_น้ำตาล_ผู้ใหญ่" (
        "ลำดับ" INT PRIMARY KEY,
        "รายละเอียด" VARCHAR(200)
      );
      COMMENT ON TABLE "ข้อมูล_น้ำตาล_ผู้ใหญ่" IS 'ทดสอบสระและวรรณยุกต์ไทย น้ำตาล ผู้ใหญ่ เก้าอี้ โต๊ะ';
      COMMENT ON COLUMN "ข้อมูล_น้ำตาล_ผู้ใหญ่"."รายละเอียด" IS 'ข้อความที่มีสระอำ ไม้เอก ไม้โท ไม้ตรี ไม้จัตวา';

      INSERT INTO "ข้อมูล_น้ำตาล_ผู้ใหญ่" VALUES 
        (1, 'น้ำตาลทรายบริสุทธิ์'),
        (2, 'ผู้ใหญ่บ้านหนองน้ำใส'),
        (3, 'เก้าอี้ไม้สักแท้');
    `);
  }

  async seedFaultInjectionComments(client) {
    // Clean Thai table alongside corrupt table in corrupt database
    await client.query(`
      DROP TABLE IF EXISTS "ตารางปกติ" CASCADE;
      CREATE TABLE "ตารางปกติ" (
        id INT PRIMARY KEY,
        name VARCHAR(50)
      );
      COMMENT ON TABLE "ตารางปกติ" IS 'ความคิดเห็นปกติ';

      DROP TABLE IF EXISTS test_corrupt_comments CASCADE;
      CREATE TABLE test_corrupt_comments (
        id INT PRIMARY KEY,
        val VARCHAR(50)
      );

      DROP TABLE IF EXISTS test_corrupt_column_comments CASCADE;
      CREATE TABLE test_corrupt_column_comments (
        id INT PRIMARY KEY,
        bad_col VARCHAR(50)
      );
    `);

    // Set client_encoding to SQL_ASCII to insert raw unmapped byte 0xDB without server checking
    await client.query(`SET client_encoding = 'SQL_ASCII';`);
    await client.query(`COMMENT ON TABLE test_corrupt_comments IS E'Corrupt Thai \\xdb comment';`);
    await client.query(`COMMENT ON COLUMN test_corrupt_column_comments.bad_col IS E'Bad column byte \\xdb in comment';`);

    // Restore client_encoding to WIN874
    await client.query(`SET client_encoding = 'WIN874';`);
  }
}

module.exports = { FixtureSeeder };
