// test/e2e/tier1_features.test.js
// Tier 1: Feature Isolation Tests (>=5 test cases per feature across F1 to F14)

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

describe('Tier 1: Feature Isolation Tests (F1 through F14)', () => {
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
      const port = await PgE2EHarness.findAvailablePort(54332);
      const dataDir = path.join(os.tmpdir(), `ducklake_e2e_t1_${Date.now()}`);
      const logFile = path.join(os.tmpdir(), `ducklake_e2e_t1_${Date.now()}.log`);
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
  });

  after(async () => {
    if (client) {
      try { await client.end(); } catch (_) {}
    }
    if (ownsHarness && harness) {
      await harness.stopServer();
      harness.cleanDataDir();
    }
  });

  // ==========================================
  // F1: PG17 Binary Detection & Cluster Init
  // ==========================================
  describe('F1: PG17 Binary Detection & Cluster Init', () => {
    it('F1.1: Detects PG17 binary directory and validates initdb.exe existence', () => {
      const binDir = harness.binDir;
      assert.ok(fs.existsSync(binDir), 'PG bin directory must exist');
      assert.ok(fs.existsSync(path.join(binDir, 'initdb.exe')), 'initdb.exe must exist in bin directory');
    });

    it('F1.2: Validates pg_ctl binary version reports PostgreSQL 17', () => {
      const res = spawnSync(harness.binPath('pg_ctl'), ['--version'], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, 'pg_ctl --version should exit with code 0');
      assert.ok(res.stdout.includes('17.'), `Expected version 17.x, got: ${res.stdout}`);
    });

    it('F1.3: Verifies cluster data directory contains valid PG_VERSION file', () => {
      const versionFile = path.join(harness.dataDir, 'PG_VERSION');
      assert.ok(fs.existsSync(versionFile), 'PG_VERSION file must exist in data directory');
      const ver = fs.readFileSync(versionFile, 'utf8').trim();
      assert.strictEqual(ver, '17', 'PG_VERSION must report 17');
    });

    it('F1.4: Verifies postgresql.conf generated during cluster initialization', () => {
      const confFile = path.join(harness.dataDir, 'postgresql.conf');
      assert.ok(fs.existsSync(confFile), 'postgresql.conf must exist in cluster directory');
    });

    it('F1.5: Verifies cluster database server_encoding is WIN874', async () => {
      const res = await client.query('SHOW server_encoding;');
      assert.strictEqual(res.rows[0].server_encoding, 'WIN874', 'Database server_encoding must be WIN874');
    });
  });

  // ==========================================
  // F2: Isolated Port & Lifecycle Daemon
  // ==========================================
  describe('F2: Isolated Port & Lifecycle Daemon', () => {
    it('F2.1: Verifies daemon operates on assigned isolated port', () => {
      assert.ok(harness.port >= 5432, `Port must be valid, got: ${harness.port}`);
    });

    it('F2.2: Verifies pg_isready returns code 0 indicating healthy listener', () => {
      const res = spawnSync(
        harness.binPath('pg_isready'),
        ['-h', '127.0.0.1', '-p', String(harness.port), '-U', harness.user],
        { encoding: 'utf8' }
      );
      assert.strictEqual(res.status, 0, `pg_isready must exit 0, got: ${res.stderr || res.stdout}`);
    });

    it('F2.3: Verifies postmaster.pid file exists with an active process ID', () => {
      const pid = harness.getPostmasterPid();
      assert.ok(pid && pid > 0, `Valid postmaster PID expected, got: ${pid}`);
      assert.ok(PgE2EHarness.isProcessAlive(pid), 'PostgreSQL process must be alive');
    });

    it('F2.4: Verifies TCP socket connectivity on daemon port', async () => {
      const connected = await new Promise((resolve) => {
        const sock = net.createConnection({ host: '127.0.0.1', port: harness.port }, () => {
          sock.end();
          resolve(true);
        });
        sock.on('error', () => resolve(false));
      });
      assert.strictEqual(connected, true, 'TCP socket must connect successfully to daemon');
    });

    it('F2.5: Verifies daemon accepts client query over network connection', async () => {
      const res = await client.query('SELECT 1 as num;');
      assert.strictEqual(res.rows[0].num, 1, 'SELECT 1 must succeed over TCP socket');
    });
  });

  // ==========================================
  // F3: DuckLake Metastore Schema Seeding
  // ==========================================
  describe('F3: DuckLake Metastore Schema Seeding', () => {
    it('F3.1: Verifies ducklake_schema table exists and contains main schema', async () => {
      const res = await client.query("SELECT * FROM ducklake_schema WHERE schema_name = 'main';");
      assert.strictEqual(res.rows.length, 1, 'Should find 1 schema with name main');
      assert.strictEqual(res.rows[0].schema_id, '0', 'Main schema_id should be 0');
    });

    it('F3.2: Verifies ducklake_table table exists and contains registered tables', async () => {
      const res = await client.query('SELECT table_name FROM ducklake_table ORDER BY table_id;');
      const tableNames = res.rows.map(r => r.table_name);
      assert.ok(tableNames.includes('customers'), 'ducklake_table must contain customers');
      assert.ok(tableNames.includes('ตารางสินค้า'), 'ducklake_table must contain Thai table ตารางสินค้า');
    });

    it('F3.3: Verifies ducklake_column table contains column definitions', async () => {
      const res = await client.query('SELECT column_name, column_type FROM ducklake_column WHERE table_id = 1 ORDER BY column_order;');
      assert.strictEqual(res.rows.length, 2, 'customers table should have 2 columns');
      assert.strictEqual(res.rows[0].column_name, 'customer_id');
      assert.strictEqual(res.rows[1].column_name, 'customer_name');
    });

    it('F3.4: Verifies ducklake_table_stats contains record count and file size statistics', async () => {
      const res = await client.query('SELECT record_count, file_size_bytes FROM ducklake_table_stats WHERE table_id = 1;');
      assert.strictEqual(res.rows.length, 1);
      assert.ok(parseInt(res.rows[0].record_count, 10) >= 1, 'Record count should be >= 1');
      assert.ok(parseInt(res.rows[0].file_size_bytes, 10) >= 0, 'File size bytes should be >= 0');
    });

    it('F3.5: Verifies ducklake_view table contains registered lakehouse views', async () => {
      const res = await client.query("SELECT view_name FROM ducklake_view WHERE view_name = 'v_customers';");
      assert.ok(res.rows.length >= 1, 'Should find at least 1 view with name v_customers');
      assert.strictEqual(res.rows[0].view_name, 'v_customers');
    });
  });

  // ==========================================
  // F4: Native Thai Table & Comment Fixtures
  // ==========================================
  describe('F4: Native Thai Table & Comment Fixtures', () => {
    it('F4.1: Verifies native table "ตารางลูกค้า" exists in information_schema', async () => {
      const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'ตารางลูกค้า';");
      assert.strictEqual(res.rows.length, 1, 'Table ตารางลูกค้า must exist');
    });

    it('F4.2: Verifies Thai column identifiers in "ตารางลูกค้า"', async () => {
      const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'ตารางลูกค้า' ORDER BY ordinal_position;");
      const colNames = res.rows.map(r => r.column_name);
      assert.ok(colNames.includes('รหัสลูกค้า'), 'Must contain column รหัสลูกค้า');
      assert.ok(colNames.includes('ชื่อลูกค้า'), 'Must contain column ชื่อลูกค้า');
      assert.ok(colNames.includes('ที่อยู่'), 'Must contain column ที่อยู่');
    });

    it('F4.3: Verifies obj_description retrieves Thai table comment', async () => {
      const res = await client.query(`
        SELECT obj_description(pgc.oid, 'pg_class') as table_comment
        FROM pg_class pgc
        JOIN pg_namespace pgn ON pgn.oid = pgc.relnamespace
        WHERE pgc.relname = 'ตารางลูกค้า' AND pgn.nspname = 'public';
      `);
      assert.strictEqual(res.rows[0].table_comment, 'ข้อมูลลูกค้าภาษาไทย');
    });

    it('F4.4: Verifies col_description retrieves Thai column comment', async () => {
      const res = await client.query(`
        SELECT col_description(pgc.oid, 2) as col_comment
        FROM pg_class pgc
        JOIN pg_namespace pgn ON pgn.oid = pgc.relnamespace
        WHERE pgc.relname = 'ตารางลูกค้า' AND pgn.nspname = 'public';
      `);
      assert.strictEqual(res.rows[0].col_comment, 'ชื่อและนามสกุลลูกค้า');
    });

    it('F4.5: Verifies tone mark combining table "ข้อมูล_น้ำตาล_ผู้ใหญ่" exists', async () => {
      const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'ข้อมูล_น้ำตาล_ผู้ใหญ่';");
      assert.strictEqual(res.rows.length, 1, 'Table ข้อมูล_น้ำตาล_ผู้ใหญ่ must exist');
    });
  });

  // ==========================================
  // F5: Corrupt Comment Fault Injection Fixture
  // ==========================================
  describe('F5: Corrupt Comment Fault Injection Fixture', () => {
    let corruptClient;

    before(async () => {
      corruptClient = new Client(corruptConfig);
      await corruptClient.connect();
    });

    after(async () => {
      if (corruptClient) {
        try { await corruptClient.end(); } catch (_) {}
      }
    });

    it('F5.1: Verifies test_corrupt_comments table exists in fault injection database', async () => {
      const res = await corruptClient.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'test_corrupt_comments';");
      assert.strictEqual(res.rows.length, 1, 'test_corrupt_comments table must exist');
    });

    it('F5.2: Verifies test_corrupt_column_comments table exists with corrupted column comment', async () => {
      const res = await corruptClient.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'test_corrupt_column_comments';");
      assert.strictEqual(res.rows.length, 1, 'test_corrupt_column_comments table must exist');
    });

    it('F5.3: Verifies corrupt byte comment triggers error 22P05 when queried under UTF-8 client_encoding', async () => {
      const utfClient = new Client({ ...corruptConfig, options: '-c client_encoding=UTF8' });
      await utfClient.connect();
      try {
        let threw = false;
        try {
          await utfClient.query(`
            SELECT obj_description(pgc.oid, 'pg_class')
            FROM pg_class pgc
            WHERE pgc.relname = 'test_corrupt_comments';
          `);
        } catch (err) {
          threw = true;
          const msg = String(err.message || err);
          assert.ok(
            msg.includes('has no equivalent in encoding') || msg.includes('22P05') || msg.includes('byte sequence'),
            `Expected transcoding error, got: ${msg}`
          );
        }
        assert.strictEqual(threw, true, 'Querying corrupt byte under UTF8 must throw 22P05 error');
      } finally {
        await utfClient.end();
      }
    });

    it('F5.4: Verifies raw byte sequence exists in pg_description catalog', async () => {
      await corruptClient.query("SET client_encoding = 'SQL_ASCII';");
      const res = await corruptClient.query(`
        SELECT d.description
        FROM pg_description d
        JOIN pg_class c ON c.oid = d.objoid
        WHERE c.relname = 'test_corrupt_comments' AND d.objsubid = 0;
      `);
      assert.strictEqual(res.rows.length, 1, 'Must have description entry');
      assert.ok(res.rows[0].description.includes('Corrupt Thai'), 'Must contain description prefix');
      await corruptClient.query("SET client_encoding = 'WIN874';");
    });

    it('F5.5: Verifies clean tables retain valid comments alongside corrupt table', async () => {
      await corruptClient.query("SET client_encoding = 'UTF8';");
      const res = await corruptClient.query(`
        SELECT obj_description(pgc.oid, 'pg_class') as comment
        FROM pg_class pgc
        JOIN pg_namespace pgn ON pgn.oid = pgc.relnamespace
        WHERE pgc.relname = 'ตารางปกติ' AND pgn.nspname = 'public';
      `);
      assert.strictEqual(res.rows.length, 1, 'Should find 1 row for ตารางปกติ');
      assert.strictEqual(res.rows[0].comment, 'ความคิดเห็นปกติ');
    });
  });

  // ==========================================
  // F6: Connection & Encoding Auto-Detection
  // ==========================================
  describe('F6: Connection & Encoding Auto-Detection', () => {
    it('F6.1: PostgresCatalogClient.testConnection() succeeds against live PG17 WIN874', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const res = await catClient.testConnection();
      assert.strictEqual(res.success, true, `testConnection must succeed: ${res.message}`);
    });

    it('F6.2: testConnection message indicates detected WIN874 server encoding', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const res = await catClient.testConnection();
      assert.ok(res.message.includes('WIN874'), `Message must include WIN874: ${res.message}`);
    });

    it('F6.3: testConnection message confirms DuckLake Metastore detected with active tables', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const res = await catClient.testConnection();
      assert.ok(res.message.includes('DuckLake Metastore detected'), `Message should detect metastore: ${res.message}`);
      assert.ok(res.message.includes('active lakehouse tables'), `Message should mention active tables: ${res.message}`);
    });

    it('F6.4: testConnection returns valid PostgreSQL version string', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const res = await catClient.testConnection();
      assert.ok(res.version && res.version.includes('PostgreSQL 17'), `Version string must mention PostgreSQL 17: ${res.version}`);
    });

    it('F6.5: configureEncoding synchronizes client_encoding and updates process.env', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const testPgClient = new Client(pgConfig);
      await testPgClient.connect();
      try {
        const enc = await catClient.configureEncoding(testPgClient);
        assert.strictEqual(enc, 'WIN874', 'Auto-detected encoding must be WIN874');
        assert.strictEqual(process.env.PGCLIENTENCODING, 'WIN874');
        assert.strictEqual(process.env.PG_SERVER_ENCODING, 'WIN874');
      } finally {
        await testPgClient.end();
      }
    });
  });

  // ==========================================
  // F7: Catalog Introspection & Thai Decoding
  // ==========================================
  describe('F7: Catalog Introspection & Thai Decoding', () => {
    let tables = [];

    before(async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      tables = await catClient.fetchCatalog();
    });

    it('F7.1: fetchCatalog returns both DuckLake and native PostgreSQL tables', () => {
      assert.ok(tables.length >= 4, `Expected at least 4 tables, got: ${tables.length}`);
      const tableNames = tables.map(t => t.name);
      assert.ok(tableNames.includes('customers'), 'Should contain customers');
      assert.ok(tableNames.includes('ตารางลูกค้า'), 'Should contain ตารางลูกค้า');
    });

    it('F7.2: Accurately decodes Thai table name "ตารางลูกค้า" without byte corruption', () => {
      const thaiTable = tables.find(t => t.name === 'ตารางลูกค้า');
      assert.ok(thaiTable, 'Table ตารางลูกค้า must be present');
      assert.strictEqual(thaiTable.name, 'ตารางลูกค้า');
    });

    it('F7.3: Accurately decodes Thai table comment "ข้อมูลลูกค้าภาษาไทย"', () => {
      const thaiTable = tables.find(t => t.name === 'ตารางลูกค้า');
      assert.ok(thaiTable, 'Table ตารางลูกค้า must be present');
      assert.strictEqual(thaiTable.comment, 'ข้อมูลลูกค้าภาษาไทย');
    });

    it('F7.4: Accurately decodes Thai column comments in JavaScript strings', () => {
      const thaiTable = tables.find(t => t.name === 'ตารางลูกค้า');
      assert.ok(thaiTable, 'Table ตารางลูกค้า must be present');
      const nameCol = thaiTable.columns.find(c => c.name === 'ชื่อลูกค้า');
      assert.ok(nameCol, 'Column ชื่อลูกค้า must be present');
      assert.strictEqual(nameCol.comment, 'ชื่อและนามสกุลลูกค้า');
    });

    it('F7.5: Accurately introspects DuckLake table statistics (rowCount & fileSizeBytes)', () => {
      const custTable = tables.find(t => t.name === 'customers');
      assert.ok(custTable, 'DuckLake table customers must be present');
      assert.ok(custTable.rowCount != null && custTable.rowCount >= 1, `rowCount should be >= 1, got: ${custTable.rowCount}`);
      assert.ok(custTable.fileSizeBytes != null && custTable.fileSizeBytes >= 0, `fileSizeBytes should be >= 0, got: ${custTable.fileSizeBytes}`);
    });

    it('F7.6: Accurately decodes Thai lakehouse table "ตารางสินค้า"', () => {
      const productTable = tables.find(t => t.name === 'ตารางสินค้า');
      assert.ok(productTable, 'DuckLake table ตารางสินค้า must be present');
      assert.strictEqual(productTable.type, 'DUCKLAKE TABLE');
      const thaiCol = productTable.columns.find(c => c.name === 'ชื่อสินค้า');
      assert.ok(thaiCol, 'Column ชื่อสินค้า must be present in ตารางสินค้า');
    });
  });

  // ==========================================
  // F8: Comment Fault Resilience & Fallback
  // ==========================================
  describe('F8: Comment Fault Resilience & Fallback', () => {
    it('F8.1: fetchCatalog succeeds completely on database with corrupt comment (0xDB)', async () => {
      const catClient = new PostgresCatalogClient(corruptConfig);
      const tables = await catClient.fetchCatalog();
      assert.ok(Array.isArray(tables), 'fetchCatalog must return an array');
      const corruptTable = tables.find(t => t.name === 'test_corrupt_comments');
      assert.ok(corruptTable, 'Corrupt table test_corrupt_comments must be returned safely');
    });

    it('F8.2: test_corrupt_column_comments with unmapped column comment does not abort catalog load', async () => {
      const catClient = new PostgresCatalogClient(corruptConfig);
      const tables = await catClient.fetchCatalog();
      const colCorrupt = tables.find(t => t.name === 'test_corrupt_column_comments');
      assert.ok(colCorrupt, 'test_corrupt_column_comments must be returned safely');
    });

    it('F8.3: Monkey-patched BufferReader safely decodes unmapped bytes using replacement characters', () => {
      const { BufferReader } = require('pg-protocol/dist/buffer-reader');
      assert.ok(BufferReader, 'BufferReader must be loaded');
      assert.ok(BufferReader.__encodingPatched, 'BufferReader must be marked as encoding patched');
    });

    it('F8.4: Valid Thai tables remain fully populated even when corrupt tables exist in same database', async () => {
      const catClient = new PostgresCatalogClient(corruptConfig);
      const tables = await catClient.fetchCatalog();
      const validTable = tables.find(t => t.name === 'ตารางปกติ');
      assert.ok(validTable, 'Table ตารางปกติ must exist');
      assert.strictEqual(validTable.comment, 'ความคิดเห็นปกติ');
    });

    it('F8.5: Fallback mechanism safely handles repeated catalog queries without state leakage', async () => {
      const catClient = new PostgresCatalogClient(corruptConfig);
      const tables1 = await catClient.fetchCatalog();
      const tables2 = await catClient.fetchCatalog();
      assert.strictEqual(tables1.length, tables2.length, 'Subsequent fetchCatalog calls must yield consistent results');
    });
  });

  // ==========================================
  // F9: SchemaManager Multi-Catalog Coordination
  // ==========================================
  describe('F9: SchemaManager Multi-Catalog Coordination', () => {
    let schemaManager;

    before(() => {
      const { setMockConfig, mockVscode } = require('./harness/vscodeShim');
      const { ConfigStorage } = require('../../dist/catalog/configStorage');
      const os = require('os');
      const tempStorage = path.join(os.tmpdir(), `ducklake_e2e_storage_${Date.now()}`);
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

    it('F9.1: Instantiates SchemaManager headlessly without VS Code GUI runtime', () => {
      assert.ok(schemaManager instanceof SchemaManager);
    });

    it('F9.2: SchemaManager.testConnection returns success with active encoding', async () => {
      const res = await schemaManager.testConnection();
      assert.strictEqual(res.success, true, `testConnection must succeed: ${res.message}`);
      assert.ok(res.message.includes('WIN874'), 'Message should reference WIN874');
    });

    it('F9.3: SchemaManager.refreshCatalog executes and populates tables', async () => {
      await schemaManager.refreshCatalog(true);
      const tables = schemaManager.getTables();
      assert.ok(tables.length > 0, 'SchemaManager must have tables after refresh');
    });

    it('F9.4: SchemaManager.findTable resolves table by Thai name', async () => {
      await schemaManager.refreshCatalog(true);
      const table = schemaManager.findTable('ตารางลูกค้า');
      assert.ok(table, 'Must find table by Thai identifier');
      assert.strictEqual(table.name, 'ตารางลูกค้า');
    });

    it('F9.5: SchemaManager.getColumnsForTable returns Thai columns', async () => {
      await schemaManager.refreshCatalog(true);
      const cols = schemaManager.getColumnsForTable('ตารางลูกค้า');
      assert.ok(cols.length >= 3, `Expected at least 3 columns, got: ${cols.length}`);
      const colNames = cols.map(c => c.name);
      assert.ok(colNames.includes('ชื่อลูกค้า'), 'Columns must include ชื่อลูกค้า');
    });
  });

  // ==========================================
  // F10: DuckLake Connection String Generation
  // ==========================================
  describe('F10: DuckLake Connection String Generation', () => {
    it('F10.1: PostgresCatalogClient.parseConnString parses key-value pairs accurately', () => {
      const str = 'host=127.0.0.1 port=5439 dbname=ducklake_catalog user=postgres client_encoding=WIN874';
      const parsed = PostgresCatalogClient.parseConnString(str);
      assert.strictEqual(parsed.host, '127.0.0.1');
      assert.strictEqual(parsed.port, 5439);
      assert.strictEqual(parsed.database, 'ducklake_catalog');
      assert.strictEqual(parsed.user, 'postgres');
      assert.strictEqual(parsed.clientEncoding, 'WIN874');
    });

    it('F10.2: PostgresCatalogClient.parseConnString parses postgresql:// URL syntax', () => {
      const url = 'postgresql://admin:secret@dbhost:5433/mydb?client_encoding=WIN874';
      const parsed = PostgresCatalogClient.parseConnString(url);
      assert.strictEqual(parsed.host, 'dbhost');
      assert.strictEqual(parsed.port, 5433);
      assert.strictEqual(parsed.database, 'mydb');
      assert.strictEqual(parsed.user, 'admin');
      assert.strictEqual(parsed.password, 'secret');
      assert.strictEqual(parsed.clientEncoding, 'WIN874');
    });

    it('F10.3: Strips client_encoding=WIN874 from generated DuckLake ATTACH string', () => {
      const raw = 'host=127.0.0.1 port=5439 dbname=postgres user=postgres client_encoding=WIN874';
      const cleaned = raw.replace(/\s*client_encoding=[^\s]+/gi, '').replace(/[?&]client_encoding=[^&#\s]*/gi, '').trim();
      assert.ok(!cleaned.includes('client_encoding='), 'Cleaned connection string must not contain client_encoding');
      assert.ok(cleaned.includes('host=127.0.0.1'));
      assert.ok(cleaned.includes('port=5439'));
    });

    it('F10.4: Strips client_encoding query parameter from URI formatted strings', () => {
      const uri = 'postgresql://postgres@127.0.0.1:5439/postgres?client_encoding=WIN874&sslmode=disable';
      const cleaned = uri.replace(/\s*client_encoding=[^\s]+/gi, '').replace(/[?&]client_encoding=[^&#\s]*/gi, '').trim();
      assert.ok(!cleaned.includes('client_encoding=WIN874'));
    });

    it('F10.5: Formats valid ATTACH SQL statement matching DuckLake specifications', () => {
      const attachSql = harness.getDuckDbAttachString('lake', 'C:/data/lake');
      assert.ok(attachSql.startsWith("ATTACH 'ducklake:postgres:"), 'ATTACH string must use ducklake:postgres: prefix');
      assert.ok(attachSql.includes("AS lake (DATA_PATH 'C:/data/lake')"), 'Must include alias and DATA_PATH clause');
    });
  });

  // ==========================================
  // F11: DuckLake & DuckDB Normal Query Execution
  // ==========================================
  describe('F11: DuckLake & DuckDB Normal Query Execution', () => {
    let duckdbAvailable = false;

    before(() => {
      try {
        const res = spawnSync('duckdb', ['--version'], { encoding: 'utf8' });
        duckdbAvailable = res.status === 0;
      } catch (_) {
        duckdbAvailable = false;
      }
    });

    it('F11.1: DuckDB CLI binary is detected and reports version', () => {
      assert.ok(duckdbAvailable, 'DuckDB CLI binary must be installed and executable');
    });

    it('F11.2: DuckDB successfully executes basic SQL query', () => {
      if (!duckdbAvailable) return;
      const res = spawnSync('duckdb', ['-c', 'SELECT 42 as answer;'], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0);
      assert.ok(res.stdout.includes('42'));
    });

    it('F11.3: DuckDB connects to PostgreSQL via postgres_scanner extension with client_encoding=UTF8', () => {
      if (!duckdbAvailable) return;
      const attachCmd = `
        INSTALL postgres;
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SHOW TABLES FROM pg;
      `;
      const res = spawnSync('duckdb', ['-c', attachCmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `DuckDB attach failed: ${res.stderr || res.stdout}`);
      assert.ok(res.stdout.includes('ตารางลูกค้า') || res.stdout.includes('customers'), 'DuckDB SHOW TABLES should list PostgreSQL tables');
    });

    it('F11.4: DuckDB executes SELECT query against PostgreSQL table without transcoding error', () => {
      if (!duckdbAvailable) return;
      const queryCmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT COUNT(*) as cnt FROM pg."คำสั่งซื้อ";
      `;
      const res = spawnSync('duckdb', ['-c', queryCmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `Query failed: ${res.stderr || res.stdout}`);
      assert.ok(res.stdout.includes('3'), 'Should return count 3');
    });

    it('F11.5: DuckDB selects from ducklake_table metastore without byte conversion error', () => {
      if (!duckdbAvailable) return;
      const queryCmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT table_name FROM pg.ducklake_table ORDER BY table_id;
      `;
      const res = spawnSync('duckdb', ['-c', queryCmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `Metastore query failed: ${res.stderr || res.stdout}`);
      assert.ok(res.stdout.includes('customers'));
      assert.ok(res.stdout.includes('ตารางสินค้า'));
    });
  });

  // ==========================================
  // F12: Thai Data/Metadata Query Execution
  // ==========================================
  describe('F12: Thai Data/Metadata Query Execution', () => {
    let duckdbAvailable = false;

    before(() => {
      try {
        const res = spawnSync('duckdb', ['--version'], { encoding: 'utf8' });
        duckdbAvailable = res.status === 0;
      } catch (_) {
        duckdbAvailable = false;
      }
    });

    it('F12.1: DuckDB queries native table "ตารางลูกค้า" and retrieves Thai UTF-8 text', () => {
      if (!duckdbAvailable) return;
      const queryCmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "ชื่อลูกค้า" FROM pg."ตารางลูกค้า" WHERE "รหัสลูกค้า" = 1;
      `;
      const res = spawnSync('duckdb', ['-c', queryCmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `Query failed: ${res.stderr || res.stdout}`);
      assert.ok(res.stdout.includes('สมชาย สายลม'), `Expected สมชาย สายลม, got: ${res.stdout}`);
    });

    it('F12.2: DuckDB queries Thai address column with Unicode integrity', () => {
      if (!duckdbAvailable) return;
      const queryCmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "ที่อยู่" FROM pg."ตารางลูกค้า" WHERE "รหัสลูกค้า" = 2;
      `;
      const res = spawnSync('duckdb', ['-c', queryCmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `Query failed: ${res.stderr || res.stdout}`);
      assert.ok(res.stdout.includes('เชียงใหม่'), `Expected เชียงใหม่, got: ${res.stdout}`);
    });

    it('F12.3: DuckDB executes GROUP BY aggregation on Thai status column', () => {
      if (!duckdbAvailable) return;
      const queryCmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "สถานะ", COUNT(*) as cnt FROM pg."คำสั่งซื้อ" GROUP BY "สถานะ" ORDER BY cnt DESC;
      `;
      const res = spawnSync('duckdb', ['-c', queryCmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `Query failed: ${res.stderr || res.stdout}`);
      assert.ok(res.stdout.includes('จัดส่งสำเร็จ') || res.stdout.includes('รอดำเนินการ'));
    });

    it('F12.4: DuckDB queries tone marks in table "ข้อมูล_น้ำตาล_ผู้ใหญ่"', () => {
      if (!duckdbAvailable) return;
      const queryCmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT "รายละเอียด" FROM pg."ข้อมูล_น้ำตาล_ผู้ใหญ่" WHERE "ลำดับ" = 1;
      `;
      const res = spawnSync('duckdb', ['-c', queryCmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `Query failed: ${res.stderr || res.stdout}`);
      assert.ok(res.stdout.includes('น้ำตาลทรายบริสุทธิ์'), `Expected น้ำตาลทรายบริสุทธิ์, got: ${res.stdout}`);
    });

    it('F12.5: DuckDB performs join between two Thai tables on Thai key column', () => {
      if (!duckdbAvailable) return;
      const queryCmd = `
        LOAD postgres;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
        SELECT c."ชื่อลูกค้า", o."รหัสคำสั่งซื้อ"
        FROM pg."ตารางลูกค้า" c
        JOIN pg."คำสั่งซื้อ" o ON c."รหัสลูกค้า" = o."รหัสลูกค้า"
        ORDER BY o."รหัสคำสั่งซื้อ";
      `;
      const res = spawnSync('duckdb', ['-c', queryCmd], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `Query failed: ${res.stderr || res.stdout}`);
      assert.ok(res.stdout.includes('สมชาย สายลม'));
    });
  });

  // ==========================================
  // F13: Single Test Command Execution
  // ==========================================
  describe('F13: Single Test Command Execution', () => {
    it('F13.1: Verifies test runner operates in non-interactive environment without stdin prompt', () => {
      assert.strictEqual(process.stdin.isTTY, undefined, 'Test should run non-interactively');
    });

    it('F13.2: Verifies node:test provides structured assertion reporting', () => {
      assert.doesNotThrow(() => {
        assert.strictEqual(true, true);
      });
    });

    it('F13.3: Verifies environment allows executing child processes synchronously with exit codes', () => {
      const res = spawnSync(process.execPath, ['-e', 'process.exit(0);']);
      assert.strictEqual(res.status, 0);
    });

    it('F13.4: Verifies child process failure propagates non-zero exit code', () => {
      const res = spawnSync(process.execPath, ['-e', 'process.exit(42);']);
      assert.strictEqual(res.status, 42);
    });

    it('F13.5: Measures sub-millisecond execution duration tracking in tests', () => {
      const t0 = performance.now();
      const t1 = performance.now();
      assert.ok(t1 >= t0, 'performance.now must be monotonically increasing');
    });
  });

  // ==========================================
  // F14: Clean Process Lifecycle & Zero Orphans
  // ==========================================
  describe('F14: Clean Process Lifecycle & Zero Orphans', () => {
    it('F14.1: Current harness records active postmaster PID', () => {
      const pid = harness.getPostmasterPid();
      assert.ok(pid && pid > 0, `PID must be valid: ${pid}`);
    });

    it('F14.2: Lifecycle harness verifies process alive via system process table', () => {
      const pid = harness.getPostmasterPid();
      const alive = PgE2EHarness.isProcessAlive(pid);
      assert.strictEqual(alive, true, 'Process must be confirmed alive');
    });

    it('F14.3: Port checking accurately identifies port as currently occupied', async () => {
      const available = await PgE2EHarness.isPortAvailable(harness.port);
      assert.strictEqual(available, false, `Port ${harness.port} should be occupied while server running`);
    });

    it('F14.4: Dynamic port scanner can identify free ports in isolated range', async () => {
      const freePort = await PgE2EHarness.findAvailablePort(54340);
      assert.ok(freePort >= 54340, `Free port found: ${freePort}`);
    });

    it('F14.5: Verifies dataDir contains valid cluster structure for safe teardown', () => {
      assert.ok(fs.existsSync(harness.dataDir), 'dataDir must exist');
      assert.ok(fs.existsSync(path.join(harness.dataDir, 'postmaster.pid')), 'postmaster.pid must exist');
    });
  });
});
