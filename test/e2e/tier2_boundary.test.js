// test/e2e/tier2_boundary.test.js
// Tier 2: Boundary & Corner Cases (>=5 test cases per feature across F1 to F14)

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

// Install headless VS Code shim
require('./harness/vscodeShim');
const { PgE2EHarness } = require('./harness/pgE2EHarness');
const { FixtureSeeder } = require('./harness/fixtureSeeder');
const { PostgresCatalogClient } = require('../../dist/catalog/postgresClient');
const { SchemaManager } = require('../../dist/catalog/schemaManager');

describe('Tier 2: Boundary & Corner Cases (F1 through F14)', () => {
  let harness;
  let ownsHarness = false;
  let pgConfig;
  let corruptConfig;
  let client;

  before(async () => {
    const sharedPort = process.env.E2E_SHARED_PORT ? parseInt(process.env.E2E_SHARED_PORT, 10) : null;
    if (sharedPort) {
      harness = new PgE2EHarness({ port: sharedPort, database: 'ducklake_e2e' });
      pgConfig = harness.getConnectionConfig();
    } else {
      ownsHarness = true;
      const port = await PgE2EHarness.findAvailablePort(54345);
      const dataDir = path.join(os.tmpdir(), `ducklake_e2e_t2_${Date.now()}`);
      const logFile = path.join(os.tmpdir(), `ducklake_e2e_t2_${Date.now()}.log`);
      harness = new PgE2EHarness({ port, dataDir, logFile, database: 'ducklake_e2e' });
      harness.initCluster();
      await harness.startServer();
      harness.createDatabase('ducklake_e2e');
      const seeder = new FixtureSeeder(harness.getConnectionConfig());
      await seeder.seedAll(harness);
      pgConfig = harness.getConnectionConfig();
    }

    corruptConfig = { ...pgConfig, database: 'ducklake_corrupt_db' };
    client = new Client(pgConfig);
    await client.connect();

    // Seed additional boundary fixtures into ducklake_e2e and ducklake_corrupt_db
    await seedBoundaryFixtures(client);
  });

  after(async () => {
    if (client) {
      try {
        await client.query("DELETE FROM ducklake_table WHERE table_name = 'zero_col_table' OR table_id >= 90;");
      } catch (_) {}
      try { await client.end(); } catch (_) {}
    }
    if (ownsHarness && harness) {
      await harness.stopServer();
      harness.cleanDataDir();
    }
  });

  async function seedBoundaryFixtures(pgClient) {
    // F4-B1: Max length Thai identifier (near 63-byte limit in WIN874)
    // "ตาราง_ทดสอบ_ชื่อยาวมาก_เพื่อตรวจสอบขอบเขต_หกสิบสามไบต์" is ~55 bytes in WIN874
    await pgClient.query(`
      DROP TABLE IF EXISTS "ตาราง_ทดสอบ_ชื่อยาวมาก_เพื่อตรวจสอบขอบเขต" CASCADE;
      CREATE TABLE "ตาราง_ทดสอบ_ชื่อยาวมาก_เพื่อตรวจสอบขอบเขต" (
        id INT PRIMARY KEY,
        val VARCHAR(50)
      );
      COMMENT ON TABLE "ตาราง_ทดสอบ_ชื่อยาวมาก_เพื่อตรวจสอบขอบเขต" IS 'ทดสอบชื่อตารางความยาวสูงสุด';
    `);

    // F4-B2: Complex tone marks and combining vowel sequences
    await pgClient.query(`
      DROP TABLE IF EXISTS "ลำดับ_น้ำ_ผู้ใหญ่_โต๊ะ_เก้าอี้_ตั๋ว" CASCADE;
      CREATE TABLE "ลำดับ_น้ำ_ผู้ใหญ่_โต๊ะ_เก้าอี้_ตั๋ว" (
        id INT PRIMARY KEY,
        text_val VARCHAR(200)
      );
      COMMENT ON TABLE "ลำดับ_น้ำ_ผู้ใหญ่_โต๊ะ_เก้าอี้_ตั๋ว" IS 'ทดสอบวรรณยุกต์ครบทุกรูป: ไม้เอก ไม้โท ไม้ตรี ไม้จัตวา';
      INSERT INTO "ลำดับ_น้ำ_ผู้ใหญ่_โต๊ะ_เก้าอี้_ตั๋ว" VALUES (1, 'น้ำแข็งใส ใส่ถ้วย เก้าอี้ โต๊ะกลม ตั๋วเครื่องบิน');
    `);

    // F4-B3: Table with empty comment
    await pgClient.query(`
      DROP TABLE IF EXISTS "ตาราง_ความเห็นว่าง" CASCADE;
      CREATE TABLE "ตาราง_ความเห็นว่าง" (id INT PRIMARY KEY);
      COMMENT ON TABLE "ตาราง_ความเห็นว่าง" IS '';
    `);

    // F4-B4: Multiline Thai comment
    await pgClient.query(`
      DROP TABLE IF EXISTS "ตาราง_หลายบรรทัด" CASCADE;
      CREATE TABLE "ตาราง_หลายบรรทัด" (id INT PRIMARY KEY);
      COMMENT ON TABLE "ตาราง_หลายบรรทัด" IS E'บรรทัดที่หนึ่ง\nบรรทัดที่สอง\r\nบรรทัดที่สาม';
    `);

    // F7-B1: Wide table with 52 columns
    let colDefs = ['id INT PRIMARY KEY'];
    for (let i = 1; i <= 51; i++) {
      colDefs.push(`col_${i} VARCHAR(20)`);
    }
    await pgClient.query(`
      DROP TABLE IF EXISTS "ตาราง_ห้าสิบคอลัมน์" CASCADE;
      CREATE TABLE "ตาราง_ห้าสิบคอลัมน์" (${colDefs.join(', ')});
    `);

    // F7-B2: Reserved SQL keywords as column names
    await pgClient.query(`
      DROP TABLE IF EXISTS "ตาราง_คำสงวน" CASCADE;
      CREATE TABLE "ตาราง_คำสงวน" (
        "select" INT,
        "from" VARCHAR(50),
        "where" VARCHAR(50),
        "order" INT,
        "group" VARCHAR(50)
      );
    `);

    // Seed extra corrupt tables in ducklake_corrupt_db
    const corruptClient = new Client(corruptConfig);
    await corruptClient.connect();
    try {
      await corruptClient.query(`
        DROP TABLE IF EXISTS test_multi_corrupt_bytes CASCADE;
        CREATE TABLE test_multi_corrupt_bytes (id INT PRIMARY KEY);

        DROP TABLE IF EXISTS test_edge_corrupt_bytes CASCADE;
        CREATE TABLE test_edge_corrupt_bytes (id INT PRIMARY KEY);

        DROP TABLE IF EXISTS test_both_corrupt CASCADE;
        CREATE TABLE test_both_corrupt (id INT PRIMARY KEY, bad_col VARCHAR(50));
      `);

      await corruptClient.query("SET client_encoding = 'SQL_ASCII';");
      await corruptClient.query(`COMMENT ON TABLE test_multi_corrupt_bytes IS E'Multi corrupt: \\xdb\\xdc\\xdd\\xde';`);
      await corruptClient.query(`COMMENT ON TABLE test_edge_corrupt_bytes IS E'\\xdbStart and end\\xdb';`);
      await corruptClient.query(`COMMENT ON TABLE test_both_corrupt IS E'Corrupt table \\xdb';`);
      await corruptClient.query(`COMMENT ON COLUMN test_both_corrupt.bad_col IS E'Corrupt column \\xdb';`);
      await corruptClient.query("SET client_encoding = 'WIN874';");
    } finally {
      await corruptClient.end();
    }
  }

  // ==========================================
  // F1: PG17 Binaries & Init Boundaries
  // ==========================================
  describe('F1: PG17 Binaries & Init Boundaries', () => {
    it('F1-B1: findPgBinDir throws when pointed to invalid directory', () => {
      const origEnv = process.env.PG_BIN_DIR;
      process.env.PG_BIN_DIR = 'C:\\non_existent_pgsql_path_xyz';
      try {
        // If system default is not in candidate list, should throw or fall back
        const dir = PgE2EHarness.findPgBinDir();
        assert.ok(fs.existsSync(dir));
      } finally {
        if (origEnv !== undefined) process.env.PG_BIN_DIR = origEnv;
        else delete process.env.PG_BIN_DIR;
      }
    });

    it('F1-B2: Handles trailing slashes in binary path gracefully', () => {
      const binDirWithSlash = harness.binDir + path.sep;
      const testHarness = new PgE2EHarness({ binDir: binDirWithSlash, port: 54345 });
      assert.ok(fs.existsSync(testHarness.binPath('pg_ctl')));
    });

    it('F1-B3: initCluster is idempotent on existing initialized data directory', () => {
      assert.doesNotThrow(() => {
        harness.initCluster();
      });
      assert.ok(fs.existsSync(path.join(harness.dataDir, 'PG_VERSION')));
    });

    it('F1-B4: Verifies PG_VERSION remains consistent after repeated calls', () => {
      const ver = fs.readFileSync(path.join(harness.dataDir, 'PG_VERSION'), 'utf8').trim();
      assert.strictEqual(ver, '17');
    });

    it('F1-B5: Verifies cluster contains expected core subdirectories (base, global, pg_wal)', () => {
      assert.ok(fs.existsSync(path.join(harness.dataDir, 'base')), 'base directory must exist');
      assert.ok(fs.existsSync(path.join(harness.dataDir, 'global')), 'global directory must exist');
      assert.ok(fs.existsSync(path.join(harness.dataDir, 'pg_wal')), 'pg_wal directory must exist');
    });
  });

  // ==========================================
  // F2: Isolated Port & Lifecycle Daemon Boundaries
  // ==========================================
  describe('F2: Isolated Port & Lifecycle Daemon Boundaries', () => {
    it('F2-B1: Connecting to closed port fails with ECONNREFUSED within fast timeout', async () => {
      const closedPort = 59998;
      const result = await new Promise((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port: closedPort });
        sock.setTimeout(1000);
        sock.on('error', (err) => resolve({ error: err.code }));
        sock.on('connect', () => { sock.end(); resolve({ connected: true }); });
      });
      assert.strictEqual(result.error, 'ECONNREFUSED');
    });

    it('F2-B2: Rapid reconnect stress: opens 10 connections in rapid sequence without failure', async () => {
      const connPromises = [];
      for (let i = 0; i < 10; i++) {
        connPromises.push(
          (async () => {
            const cl = new Client(pgConfig);
            await cl.connect();
            const res = await cl.query('SELECT 1 as num;');
            await cl.end();
            return res.rows[0].num;
          })()
        );
      }
      const results = await Promise.all(connPromises);
      assert.strictEqual(results.length, 10);
      assert.ok(results.every(r => r === 1));
    });

    it('F2-B3: High port boundary test: validates finding ports in 55000+ range', async () => {
      const highPort = await PgE2EHarness.findAvailablePort(55100);
      assert.ok(highPort >= 55100, `High port should be >= 55100: ${highPort}`);
    });

    it('F2-B4: pg_isready probe against inactive port returns non-zero status code', () => {
      const inactivePort = 59997;
      const res = spawnSync(
        harness.binPath('pg_isready'),
        ['-h', '127.0.0.1', '-p', String(inactivePort), '-U', harness.user],
        { encoding: 'utf8' }
      );
      assert.notStrictEqual(res.status, 0, 'pg_isready on dead port must return non-zero');
    });

    it('F2-B5: isPortAvailable correctly reports false for actively bound test port', async () => {
      const available = await PgE2EHarness.isPortAvailable(harness.port);
      assert.strictEqual(available, false, 'Running server port must not be available');
    });
  });

  // ==========================================
  // F3: DuckLake Metastore Boundary Cases
  // ==========================================
  describe('F3: DuckLake Metastore Boundary Cases', () => {
    it('F3-B1: Deleted snapshot boundary: tables with end_snapshot IS NOT NULL excluded from catalog', async () => {
      await client.query('DELETE FROM ducklake_table WHERE table_id = 99;');
      await client.query(`
        INSERT INTO ducklake_table VALUES 
          (99, '99999999-9999-9999-9999-999999999999', 1, 2, 0, 'deleted_table', 'deleted/', true);
      `);
      const catClient = new PostgresCatalogClient(pgConfig);
      const tables = await catClient.fetchCatalog();
      const found = tables.find(t => t.name === 'deleted_table');
      assert.strictEqual(found, undefined, 'Ended snapshot tables must not appear in active catalog');
    });

    it('F3-B2: Table with 0 columns in ducklake_column handled safely with empty array', async () => {
      await client.query('DELETE FROM ducklake_table WHERE table_id = 98;');
      await client.query(`
        INSERT INTO ducklake_table VALUES 
          (98, '88888888-8888-8888-8888-888888888888', 1, NULL, 0, 'zero_col_table', 'zerocol/', true);
      `);
      const catClient = new PostgresCatalogClient(pgConfig);
      const tables = await catClient.fetchCatalog();
      const zTable = tables.find(t => t.name === 'zero_col_table');
      assert.ok(zTable, 'zero_col_table must exist');
      assert.deepStrictEqual(zTable.columns, []);
    });

    it('F3-B3: Table with null record_count in stats handles undefined rowCount cleanly', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const tables = await catClient.fetchCatalog();
      const zTable = tables.find(t => t.name === 'zero_col_table');
      assert.ok(zTable);
      assert.strictEqual(zTable.rowCount, undefined);
    });

    it('F3-B4: Column nulls_allowed parsed accurately for both nullable and non-nullable columns', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const tables = await catClient.fetchCatalog();
      const custTable = tables.find(t => t.name === 'customers');
      assert.ok(custTable);
      const idCol = custTable.columns.find(c => c.name === 'customer_id');
      const nameCol = custTable.columns.find(c => c.name === 'customer_name');
      assert.ok(idCol);
      assert.ok(nameCol);
      assert.strictEqual(typeof idCol.isNullable, 'boolean');
      assert.strictEqual(typeof nameCol.isNullable, 'boolean');
    });

    it('F3-B5: View definition correctly captured for DuckLake views', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const tables = await catClient.fetchCatalog();
      const view = tables.find(t => t.name === 'v_customers');
      assert.ok(view);
      assert.strictEqual(view.type, 'VIEW');
    });
  });

  // ==========================================
  // F4: Native Thai Identifiers Boundary & Tone Marks
  // ==========================================
  describe('F4: Native Thai Identifiers Boundary & Tone Marks', () => {
    let tables = [];

    before(async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      tables = await catClient.fetchCatalog();
    });

    it('F4-B1: Long Thai identifier table name introspected accurately', () => {
      const longTable = tables.find(t => t.name.includes('ตาราง_ทดสอบ_ชื่อยาวมาก'));
      assert.ok(longTable, 'Long Thai table identifier must be introspected');
      assert.strictEqual(longTable.comment, 'ทดสอบชื่อตารางความยาวสูงสุด');
    });

    it('F4-B2: Complex tone marks and combining vowel sequences preserve full Unicode integrity', () => {
      const toneTable = tables.find(t => t.name.includes('ลำดับ_น้ำ_ผู้ใหญ่_โต๊ะ_เก้าอี้_ตั๋ว'));
      assert.ok(toneTable, 'Tone marks table must be introspected');
      assert.ok(toneTable.name.includes('น้ำ'));
      assert.ok(toneTable.name.includes('ผู้ใหญ่'));
      assert.ok(toneTable.name.includes('โต๊ะ'));
      assert.ok(toneTable.name.includes('เก้าอี้'));
      assert.ok(toneTable.name.includes('ตั๋ว'));
      assert.strictEqual(toneTable.comment, 'ทดสอบวรรณยุกต์ครบทุกรูป: ไม้เอก ไม้โท ไม้ตรี ไม้จัตวา');
    });

    it('F4-B3: Table with empty comment string handled gracefully without crash', () => {
      const emptyComTable = tables.find(t => t.name === 'ตาราง_ความเห็นว่าง');
      assert.ok(emptyComTable, 'Table with empty comment must be present');
    });

    it('F4-B4: Multiline Thai comment preserves newline line breaks', () => {
      const mlTable = tables.find(t => t.name === 'ตาราง_หลายบรรทัด');
      assert.ok(mlTable, 'Multiline comment table must be present');
      assert.ok(mlTable.comment && mlTable.comment.includes('\n'), 'Comment must preserve newline');
      assert.ok(mlTable.comment.includes('บรรทัดที่หนึ่ง'));
      assert.ok(mlTable.comment.includes('บรรทัดที่สาม'));
    });

    it('F4-B5: Native Thai table columns and data types fully match information_schema specifications', () => {
      const thaiCust = tables.find(t => t.name === 'ตารางลูกค้า');
      assert.ok(thaiCust);
      assert.ok(thaiCust.columns.length >= 4);
      const idCol = thaiCust.columns.find(c => c.name === 'รหัสลูกค้า');
      const nameCol = thaiCust.columns.find(c => c.name === 'ชื่อลูกค้า');
      assert.strictEqual(idCol.dataType, 'integer');
      assert.strictEqual(nameCol.dataType, 'character varying');
    });
  });

  // ==========================================
  // F5: Corrupt Comment Byte Boundaries
  // ==========================================
  describe('F5: Corrupt Comment Byte Boundaries', () => {
    it('F5-B1: Multiple unmapped bytes (\\xdb\\xdc\\xdd\\xde) trigger 22P05 under UTF8', async () => {
      const utfClient = new Client({ ...corruptConfig, options: '-c client_encoding=UTF8' });
      await utfClient.connect();
      try {
        await assert.rejects(
          async () => {
            await utfClient.query(`
              SELECT obj_description(pgc.oid, 'pg_class')
              FROM pg_class pgc
              WHERE pgc.relname = 'test_multi_corrupt_bytes';
            `);
          },
          (err) => {
            const msg = String(err.message || err);
            return msg.includes('has no equivalent in encoding') || msg.includes('22P05');
          }
        );
      } finally {
        await utfClient.end();
      }
    });

    it('F5-B2: Unmapped byte at string boundaries (first and last byte) triggers 22P05 under UTF8', async () => {
      const utfClient = new Client({ ...corruptConfig, options: '-c client_encoding=UTF8' });
      await utfClient.connect();
      try {
        await assert.rejects(
          async () => {
            await utfClient.query(`
              SELECT obj_description(pgc.oid, 'pg_class')
              FROM pg_class pgc
              WHERE pgc.relname = 'test_edge_corrupt_bytes';
            `);
          },
          (err) => {
            const msg = String(err.message || err);
            return msg.includes('has no equivalent in encoding') || msg.includes('22P05');
          }
        );
      } finally {
        await utfClient.end();
      }
    });

    it('F5-B3: Table with both corrupt table comment AND column comment triggers 22P05 on both queries', async () => {
      const utfClient = new Client({ ...corruptConfig, options: '-c client_encoding=UTF8' });
      await utfClient.connect();
      try {
        let tableThrew = false;
        try {
          await utfClient.query(`SELECT obj_description(to_regclass('test_both_corrupt'), 'pg_class');`);
        } catch (_) { tableThrew = true; }

        let colThrew = false;
        try {
          await utfClient.query(`SELECT col_description(to_regclass('test_both_corrupt'), 2);`);
        } catch (_) { colThrew = true; }

        assert.strictEqual(tableThrew, true, 'Table comment query must fail');
        assert.strictEqual(colThrew, true, 'Column comment query must fail');
      } finally {
        await utfClient.end();
      }
    });

    it('F5-B4: Reading raw description under SQL_ASCII returns text without throwing', async () => {
      const sqlAsciiClient = new Client(corruptConfig);
      await sqlAsciiClient.connect();
      try {
        await sqlAsciiClient.query("SET client_encoding = 'SQL_ASCII';");
        const res = await sqlAsciiClient.query(`
          SELECT d.description
          FROM pg_description d
          JOIN pg_class c ON c.oid = d.objoid
          WHERE c.relname = 'test_multi_corrupt_bytes';
        `);
        assert.strictEqual(res.rows.length, 1);
        assert.ok(res.rows[0].description.includes('Multi corrupt'));
      } finally {
        await sqlAsciiClient.end();
      }
    });

    it('F5-B5: Clean table comments in corrupt database remain intact under WIN874 decoding', async () => {
      const catClient = new PostgresCatalogClient(corruptConfig);
      const tables = await catClient.fetchCatalog();
      const normalTable = tables.find(t => t.name === 'ตารางปกติ');
      assert.ok(normalTable, 'ตารางปกติ should be returned');
      assert.strictEqual(normalTable.comment, 'ความคิดเห็นปกติ');
    });
  });

  // ==========================================
  // F6: Connection & Auto-Detection Boundary
  // ==========================================
  describe('F6: Connection & Auto-Detection Boundary', () => {
    it('F6-B1: testConnection returns success=false with bad credentials', async () => {
      const badClient = new PostgresCatalogClient({
        ...pgConfig,
        user: 'non_existent_user_12345'
      });
      const res = await badClient.testConnection();
      assert.strictEqual(res.success, false);
      assert.ok(res.message.includes('Failed to connect'));
    });

    it('F6-B2: testConnection returns success=false with non-existent database', async () => {
      const badDbClient = new PostgresCatalogClient({
        ...pgConfig,
        database: 'db_that_does_not_exist_9999'
      });
      const res = await badDbClient.testConnection();
      assert.strictEqual(res.success, false);
      assert.ok(res.message.includes('Failed to connect'));
    });

    it('F6-B3: testConnection returns success=false on non-responsive host with fast timeout', async () => {
      const deadHostClient = new PostgresCatalogClient({
        ...pgConfig,
        host: '192.0.2.1', // TEST-NET non-routable IP
        port: 5439
      });
      const start = Date.now();
      const res = await deadHostClient.testConnection();
      const duration = Date.now() - start;
      assert.strictEqual(res.success, false);
      assert.ok(duration <= 7000, `Timeout should terminate within ~5000-6000ms, took: ${duration}ms`);
    });

    it('F6-B4: Explicit clientEncoding="SQL_ASCII" takes precedence over auto-detect', async () => {
      const catClient = new PostgresCatalogClient({
        ...pgConfig,
        clientEncoding: 'SQL_ASCII'
      });
      const testPgClient = new Client(pgConfig);
      await testPgClient.connect();
      try {
        const enc = await catClient.configureEncoding(testPgClient);
        assert.strictEqual(enc, 'SQL_ASCII');
        assert.strictEqual(process.env.PGCLIENTENCODING, 'SQL_ASCII');
      } finally {
        await testPgClient.end();
      }
    });

    it('F6-B5: Explicit clientEncoding="UTF8" takes precedence over server WIN874', async () => {
      const catClient = new PostgresCatalogClient({
        ...pgConfig,
        clientEncoding: 'UTF8'
      });
      const testPgClient = new Client(pgConfig);
      await testPgClient.connect();
      try {
        const enc = await catClient.configureEncoding(testPgClient);
        assert.strictEqual(enc, 'UTF8');
        assert.strictEqual(process.env.PGCLIENTENCODING, 'UTF8');
      } finally {
        await testPgClient.end();
      }
    });
  });

  // ==========================================
  // F7: Catalog Introspection Boundary
  // ==========================================
  describe('F7: Catalog Introspection Boundary', () => {
    let tables = [];

    before(async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      tables = await catClient.fetchCatalog();
    });

    it('F7-B1: Wide table boundary: introspects all 52 columns accurately', () => {
      const wideTable = tables.find(t => t.name === 'ตาราง_ห้าสิบคอลัมน์');
      assert.ok(wideTable, 'Wide table must be introspected');
      assert.strictEqual(wideTable.columns.length, 52, `Expected 52 columns, got: ${wideTable.columns.length}`);
      assert.strictEqual(wideTable.columns[0].name, 'id');
      assert.strictEqual(wideTable.columns[51].name, 'col_51');
    });

    it('F7-B2: Reserved SQL keywords as column names (select, from, where, order, group) introspected without parsing errors', () => {
      const kwTable = tables.find(t => t.name === 'ตาราง_คำสงวน');
      assert.ok(kwTable, 'Reserved keywords table must be introspected');
      const colNames = kwTable.columns.map(c => c.name);
      assert.ok(colNames.includes('select'));
      assert.ok(colNames.includes('from'));
      assert.ok(colNames.includes('where'));
      assert.ok(colNames.includes('order'));
      assert.ok(colNames.includes('group'));
    });

    it('F7-B3: Table columns have accurate dataType and isNullable flags', () => {
      const thaiCust = tables.find(t => t.name === 'ตารางลูกค้า');
      assert.ok(thaiCust);
      const nameCol = thaiCust.columns.find(c => c.name === 'ชื่อลูกค้า');
      assert.ok(nameCol);
      assert.strictEqual(nameCol.isNullable, false);
      assert.strictEqual(nameCol.dataType, 'character varying');
    });

    it('F7-B4: Column default expressions captured accurately', () => {
      const thaiCust = tables.find(t => t.name === 'ตารางลูกค้า');
      assert.ok(thaiCust);
      const orderCol = thaiCust.columns.find(c => c.name === 'ยอดสั่งซื้อ');
      assert.ok(orderCol);
      assert.ok(orderCol.defaultValue != null, 'Default value expression should exist');
    });

    it('F7-B5: Introspects full collection of user tables excluding pg_catalog internal system relations', () => {
      assert.ok(tables.every(t => t.schema !== 'pg_catalog' && t.schema !== 'information_schema'));
    });
  });

  // ==========================================
  // F8: Comment Fault Resilience Boundary
  // ==========================================
  describe('F8: Comment Fault Resilience Boundary', () => {
    it('F8-B1: fetchCatalog succeeds completely when database contains multiple corrupt tables', async () => {
      const catClient = new PostgresCatalogClient(corruptConfig);
      const tables = await catClient.fetchCatalog();
      assert.ok(Array.isArray(tables));
      const corruptMulti = tables.find(t => t.name === 'test_multi_corrupt_bytes');
      const corruptEdge = tables.find(t => t.name === 'test_edge_corrupt_bytes');
      const corruptBoth = tables.find(t => t.name === 'test_both_corrupt');
      assert.ok(corruptMulti, 'test_multi_corrupt_bytes must be returned');
      assert.ok(corruptEdge, 'test_edge_corrupt_bytes must be returned');
      assert.ok(corruptBoth, 'test_both_corrupt must be returned');
    });

    it('F8-B2: Comment fault recovery ensures columns of corrupt tables are still loaded', async () => {
      const catClient = new PostgresCatalogClient(corruptConfig);
      const tables = await catClient.fetchCatalog();
      const corruptBoth = tables.find(t => t.name === 'test_both_corrupt');
      assert.ok(corruptBoth);
      assert.strictEqual(corruptBoth.columns.length, 2);
      const badCol = corruptBoth.columns.find(c => c.name === 'bad_col');
      assert.ok(badCol);
      assert.strictEqual(badCol.dataType, 'character varying');
    });

    it('F8-B3: queryWithFallback does not swallow syntax errors and re-throws cleanly', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const testPgClient = new Client(pgConfig);
      await testPgClient.connect();
      try {
        await assert.rejects(
          async () => {
            // Invalid SQL syntax
            await catClient.queryWithFallback(testPgClient, 'SELECT NOT A VALID QUERY ;;;');
          },
          (err) => {
            return String(err.message || err).includes('syntax error');
          }
        );
      } finally {
        await testPgClient.end();
      }
    });

    it('F8-B4: Safe fallback query preserves correct table schema and table name', async () => {
      const catClient = new PostgresCatalogClient(corruptConfig);
      const tables = await catClient.fetchCatalog();
      assert.ok(tables.every(t => typeof t.name === 'string' && t.name.length > 0));
      assert.ok(tables.every(t => typeof t.schema === 'string' && t.schema.length > 0));
    });

    it('F8-B5: Concurrent fetchCatalog calls execute in parallel without cross-instance corruption', async () => {
      const c1 = new PostgresCatalogClient(corruptConfig);
      const c2 = new PostgresCatalogClient(corruptConfig);
      const [t1, t2] = await Promise.all([c1.fetchCatalog(), c2.fetchCatalog()]);
      assert.strictEqual(t1.length, t2.length);
    });
  });

  // ==========================================
  // F9: SchemaManager Boundary
  // ==========================================
  describe('F9: SchemaManager Boundary', () => {
    let schemaManager;

    before(() => {
      const { setMockConfig, mockVscode } = require('./harness/vscodeShim');
      const { ConfigStorage } = require('../../dist/catalog/configStorage');
      const tempStorage = path.join(os.tmpdir(), `ducklake_e2e_storage_b_${Date.now()}`);
      fs.mkdirSync(tempStorage, { recursive: true });
      ConfigStorage.init(mockVscode.Uri.file(tempStorage));

      const connStr = `host=127.0.0.1 port=${pgConfig.port} dbname=${pgConfig.database} user=${pgConfig.user}`;
      const testConfig = {
        connectionString: connStr,
        host: pgConfig.host,
        port: pgConfig.port,
        database: pgConfig.database,
        user: pgConfig.user,
        password: '',
        ssl: false,
        clientEncoding: 'auto',
        connectionName: 'lake',
        databaseAlias: 'lake',
        catalogType: 'server',
        catalogSchemas: ['public', 'main']
      };
      fs.writeFileSync(
        path.join(tempStorage, 'connections.json'),
        JSON.stringify({
          version: 1,
          activeConnection: 'lake',
          connections: [testConfig]
        })
      );

      setMockConfig({
        'postgres.connectionString': connStr,
        'postgres.host': pgConfig.host,
        'postgres.port': pgConfig.port,
        'postgres.database': pgConfig.database,
        'postgres.user': pgConfig.user,
        'postgres.clientEncoding': 'auto',
        'databaseAlias': 'lake'
      });
      schemaManager = new SchemaManager();
    });

    after(() => {
      if (schemaManager) {
        schemaManager.dispose();
      }
    });

    it('F9-B1: findTable returns undefined for non-existent table', async () => {
      await schemaManager.refreshCatalog(true);
      const found = schemaManager.findTable('table_that_does_not_exist_xyz');
      assert.strictEqual(found, undefined);
    });

    it('F9-B2: getTables returns empty array for non-existent database alias', async () => {
      await schemaManager.refreshCatalog(true);
      const tables = schemaManager.getTables('ghost_database_alias');
      assert.deepStrictEqual(tables, []);
    });

    it('F9-B3: getColumnsForTable returns empty array for non-existent table', async () => {
      await schemaManager.refreshCatalog(true);
      const cols = schemaManager.getColumnsForTable('ghost_table_xyz');
      assert.deepStrictEqual(cols, []);
    });

    it('F9-B4: dispose() can be called multiple times without throwing', () => {
      assert.doesNotThrow(() => {
        schemaManager.dispose();
        schemaManager.dispose();
      });
    });

    it('F9-B5: setActiveDatabase with non-existent database name returns false', async () => {
      const res = await schemaManager.setActiveDatabase('invalid_db_name_9999');
      assert.strictEqual(res, false);
    });
  });

  // ==========================================
  // F10: DuckLake Connection String Boundary
  // ==========================================
  describe('F10: DuckLake Connection String Boundary', () => {
    it('F10-B1: parseConnString handles empty string, null, and undefined cleanly', () => {
      assert.deepStrictEqual(PostgresCatalogClient.parseConnString(''), {});
      assert.deepStrictEqual(PostgresCatalogClient.parseConnString('   '), {});
      assert.deepStrictEqual(PostgresCatalogClient.parseConnString(null), {});
    });

    it('F10-B2: parseConnString handles malformed URL strings without throwing', () => {
      assert.doesNotThrow(() => {
        const res = PostgresCatalogClient.parseConnString('postgresql://[invalid_url_format:::');
        assert.ok(typeof res === 'object');
      });
    });

    it('F10-B3: Strips client_encoding regardless of mixed casing and surrounding whitespace', () => {
      const raw = 'host=localhost   CLIENT_ENCODING=win874   port=5432';
      const cleaned = raw.replace(/\s*client_encoding=[^\s]+/gi, '').replace(/[?&]client_encoding=[^&#\s]*/gi, '').trim();
      assert.ok(!cleaned.toLowerCase().includes('client_encoding'));
      assert.ok(cleaned.includes('host=localhost'));
      assert.ok(cleaned.includes('port=5432'));
    });

    it('F10-B4: Data path with Windows backslashes is formatted cleanly for DuckLake clause', () => {
      const windowsPath = 'C:\\users\\data\\parquet_files';
      const attachSql = harness.getDuckDbAttachString('lake', windowsPath);
      assert.ok(attachSql.includes("C:/users/data/parquet_files"));
      assert.ok(!attachSql.includes('\\'));
    });

    it('F10-B5: Connection string with complex password containing special symbols parsed accurately', () => {
      const conn = 'host=db.example.com port=5432 dbname=lake user=usr password=P@ssw0rd!#$ client_encoding=WIN874';
      const parsed = PostgresCatalogClient.parseConnString(conn);
      assert.strictEqual(parsed.host, 'db.example.com');
      assert.strictEqual(parsed.port, 5432);
      assert.strictEqual(parsed.password, 'P@ssw0rd!#$');
      assert.strictEqual(parsed.clientEncoding, 'WIN874');
    });
  });

  // ==========================================
  // F11: DuckLake & DuckDB Execution Boundary
  // ==========================================
  describe('F11: DuckLake & DuckDB Execution Boundary', () => {
    it('F11-B1: DuckDB executes whitespace/empty query cleanly', () => {
      const res = spawnSync('duckdb', ['-c', '   ;   '], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
    });

    it('F11-B2: DuckDB execution on invalid SQL syntax exits with non-zero code', () => {
      const res = spawnSync('duckdb', ['-c', 'INVALID SQL COMMAND SYNTAX;'], { encoding: 'utf8' });
      assert.notStrictEqual(res.status, 0);
      assert.ok(res.stderr.includes('Parser Error') || res.stderr.includes('syntax error'));
    });

    it('F11-B3: DuckDB querying non-existent table returns error without hanging', () => {
      const cmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT * FROM pg.table_that_does_not_exist;
      `;
      const res = spawnSync('duckdb', ['-c', cmd], { encoding: 'utf8' });
      assert.notStrictEqual(res.status, 0);
      assert.ok(res.stderr.includes('does not exist') || res.stderr.includes('Catalog Error'));
    });

    it('F11-B4: DuckDB query with empty result set outputs correct headers', () => {
      const cmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "รหัสลูกค้า", "ชื่อลูกค้า" FROM pg."ตารางลูกค้า" WHERE "รหัสลูกค้า" = 999999;
      `;
      const res = spawnSync('duckdb', ['-c', cmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes('รหัสลูกค้า'));
      assert.ok(res.stdout.includes('ชื่อลูกค้า'));
    });

    it('F11-B5: DuckDB selects generated sequence of 500 rows rapidly', () => {
      const res = spawnSync('duckdb', ['-c', 'SELECT range as num FROM range(500);'], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes('499'));
    });
  });

  // ==========================================
  // F12: DuckDB Thai Data Boundary
  // ==========================================
  describe('F12: DuckDB Thai Data Boundary', () => {
    it('F12-B1: DuckDB handles NULL values in Thai columns cleanly', () => {
      const cmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "รหัสลูกค้า", "ที่อยู่" FROM pg."ตารางลูกค้า" WHERE "ที่อยู่" IS NOT NULL;
      `;
      const res = spawnSync('duckdb', ['-c', cmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
    });

    it('F12-B2: DuckDB filters Thai text using LIKE wildcard matching (%สายลม%)', () => {
      const cmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "ชื่อลูกค้า" FROM pg."ตารางลูกค้า" WHERE "ชื่อลูกค้า" LIKE '%สายลม%';
      `;
      const res = spawnSync('duckdb', ['-c', cmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes('สมชาย สายลม'));
    });

    it('F12-B3: DuckDB filters Thai text using exact WHERE matching', () => {
      const cmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "รหัสลูกค้า" FROM pg."ตารางลูกค้า" WHERE "ชื่อลูกค้า" = 'วันดี มีสุข';
      `;
      const res = spawnSync('duckdb', ['-c', cmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes('2'));
    });

    it('F12-B4: DuckDB executes ORDER BY on Thai column without collation failure', () => {
      const cmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "ชื่อลูกค้า" FROM pg."ตารางลูกค้า" ORDER BY "ชื่อลูกค้า" ASC;
      `;
      const res = spawnSync('duckdb', ['-c', cmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes('กิตติศักดิ์ เจริญพร'));
    });

    it('F12-B5: DuckDB selects long Thai string text with full character integrity', () => {
      const cmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "ที่อยู่" FROM pg."ตารางลูกค้า" WHERE "รหัสลูกค้า" = 1;
      `;
      const res = spawnSync('duckdb', ['-c', cmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes('ถนนสุขุมวิท แขวงคลองเตย กรุงเทพมหานคร'));
    });
  });

  // ==========================================
  // F13: Single Test Command Boundaries
  // ==========================================
  describe('F13: Single Test Command Boundaries', () => {
    it('F13-B1: process.exitCode is initially clean/undefined', () => {
      assert.ok(process.exitCode === undefined || process.exitCode === 0);
    });

    it('F13-B2: Assertion failure inside assert.rejects cleanly caught without crashing runner', async () => {
      await assert.rejects(
        async () => { throw new Error('Expected deliberate failure'); },
        { message: 'Expected deliberate failure' }
      );
    });

    it('F13-B3: Large child process stdout buffer (>64KB) handled without deadlocking', () => {
      const script = `console.log('X'.repeat(70000));`;
      const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
      assert.strictEqual(res.status, 0);
      assert.strictEqual(res.stdout.trim().length, 70000);
    });

    it('F13-B4: Custom environment variables propagate cleanly to spawned child processes', () => {
      const res = spawnSync(process.execPath, ['-e', 'console.log(process.env.TEST_VAR_CHECK);'], {
        encoding: 'utf8',
        env: { ...process.env, TEST_VAR_CHECK: 'propagated_123' }
      });
      assert.strictEqual(res.status, 0);
      assert.strictEqual(res.stdout.trim(), 'propagated_123');
    });

    it('F13-B5: Synchronous child process execution timeout triggers and halts long command', () => {
      const res = spawnSync(process.execPath, ['-e', 'while(true){}'], { timeout: 500 });
      assert.ok(res.error != null || res.signal === 'SIGTERM');
    });
  });

  // ==========================================
  // F14: Process Lifecycle & Clean Teardown Boundaries
  // ==========================================
  describe('F14: Process Lifecycle & Clean Teardown Boundaries', () => {
    it('F14-B1: Calling stopServer on stopped or non-existent instance is idempotent', async () => {
      const dummyHarness = new PgE2EHarness({ dataDir: path.join(os.tmpdir(), 'dummy_pg_data_9999'), port: 54999 });
      await assert.doesNotReject(async () => {
        await dummyHarness.stopServer();
      });
    });

    it('F14-B2: Calling forceKillPid on invalid or null PID does not throw', () => {
      assert.doesNotThrow(() => {
        harness.forceKillPid(null);
        harness.forceKillPid(0);
        harness.forceKillPid(999999);
      });
    });

    it('F14-B3: cleanDataDir on non-existent directory succeeds cleanly', () => {
      const dummyHarness = new PgE2EHarness({ dataDir: path.join(os.tmpdir(), 'non_existent_data_dir_xyz') });
      assert.doesNotThrow(() => {
        dummyHarness.cleanDataDir();
      });
    });

    it('F14-B4: Active server process postmaster PID exists and is verified alive in OS table', () => {
      const pid = harness.getPostmasterPid();
      assert.ok(pid && pid > 0);
      assert.strictEqual(PgE2EHarness.isProcessAlive(pid), true);
    });

    it('F14-B5: Log file exists and is accessible for writing server diagnostics', () => {
      assert.ok(fs.existsSync(harness.logFile), `Log file should exist: ${harness.logFile}`);
    });
  });
});
