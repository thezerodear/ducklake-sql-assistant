// test/e2e/tier3_combinations.test.js
// Tier 3: Cross-Feature Combinations & Pairwise Interaction Tests

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

// Install headless VS Code shim
require('./harness/vscodeShim');
const { PgE2EHarness } = require('./harness/pgE2EHarness');
const { FixtureSeeder } = require('./harness/fixtureSeeder');
const { PostgresCatalogClient } = require('../../dist/catalog/postgresClient');
const { SchemaManager } = require('../../dist/catalog/schemaManager');

describe('Tier 3: Cross-Feature Combinations (Pairwise & Multi-Feature)', () => {
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
      const port = await PgE2EHarness.findAvailablePort(54350);
      const dataDir = path.join(os.tmpdir(), `ducklake_e2e_t3_${Date.now()}`);
      const logFile = path.join(os.tmpdir(), `ducklake_e2e_t3_${Date.now()}.log`);
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

  // Combo 1: F3 (DuckLake Metastore) + F4 (Native Thai Fixtures) + F7 (Catalog Introspection)
  describe('Combo 1: F3 (Metastore) + F4 (Thai Fixtures) + F7 (Introspection)', () => {
    it('Simultaneously introspects DuckLake tables and native Thai tables with accurate types and comments', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);
      const tables = await catClient.fetchCatalog();

      const duckTable = tables.find(t => t.name === 'customers');
      const thaiNative = tables.find(t => t.name === 'ตารางลูกค้า');
      const thaiLake = tables.find(t => t.name === 'ตารางสินค้า');

      assert.ok(duckTable, 'DuckLake table customers must exist');
      assert.ok(thaiNative, 'Native Thai table ตารางลูกค้า must exist');
      assert.ok(thaiLake, 'Thai lakehouse table ตารางสินค้า must exist');

      assert.strictEqual(duckTable.type, 'DUCKLAKE TABLE');
      assert.strictEqual(thaiLake.type, 'DUCKLAKE TABLE');
      assert.strictEqual(thaiNative.type, 'BASE TABLE');

      assert.strictEqual(thaiNative.comment, 'ข้อมูลลูกค้าภาษาไทย');
      const thaiCol = thaiNative.columns.find(c => c.name === 'ชื่อลูกค้า');
      assert.ok(thaiCol);
      assert.strictEqual(thaiCol.comment, 'ชื่อและนามสกุลลูกค้า');
    });
  });

  // Combo 2: F5 (Corrupt Comments) + F7 (Thai Decoding) + F8 (Comment Fault Resilience)
  describe('Combo 2: F5 (Corrupt Comments) + F7 (Thai Decoding) + F8 (Resilience)', () => {
    it('Introspects database where corrupt comments coexist with legitimate Thai tables without data loss', async () => {
      const catClient = new PostgresCatalogClient(corruptConfig);
      const tables = await catClient.fetchCatalog();

      const corruptTable = tables.find(t => t.name === 'test_corrupt_comments');
      const normalTable = tables.find(t => t.name === 'ตารางปกติ');

      assert.ok(corruptTable, 'Corrupt table must still be returned');
      assert.ok(normalTable, 'Clean table ตารางปกติ must be returned');

      assert.strictEqual(normalTable.comment, 'ความคิดเห็นปกติ');
    });
  });

  // Combo 3: F6 (Encoding Auto-Detect) + F7 (Thai Decoding) + F9 (SchemaManager Coordination)
  describe('Combo 3: F6 (Auto-Detect) + F7 (Thai Decoding) + F9 (SchemaManager)', () => {
    let schemaManager;

    before(() => {
      const { setMockConfig, mockVscode } = require('./harness/vscodeShim');
      const { ConfigStorage } = require('../../dist/catalog/configStorage');
      const tempStorage = path.join(os.tmpdir(), `ducklake_combo3_${Date.now()}`);
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
        JSON.stringify({ version: 1, activeConnection: 'lake', connections: [testConfig] })
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
      if (schemaManager) schemaManager.dispose();
    });

    it('SchemaManager auto-detects WIN874, refreshes catalog, and resolves multi-part Thai table identifiers', async () => {
      const testConn = await schemaManager.testConnection();
      assert.strictEqual(testConn.success, true);
      assert.ok(testConn.message.includes('WIN874'));

      await schemaManager.refreshCatalog(true);
      const tables = schemaManager.getTables();
      assert.ok(tables.length >= 3);

      const table1 = schemaManager.findTable('ตารางลูกค้า');
      assert.ok(table1);
      assert.strictEqual(table1.name, 'ตารางลูกค้า');

      const table2 = schemaManager.findTable('public.ตารางลูกค้า');
      assert.ok(table2);
      assert.strictEqual(table2.name, 'ตารางลูกค้า');

      const cols = schemaManager.getColumnsForTable('ตารางลูกค้า');
      assert.ok(cols.length >= 3);
      assert.ok(cols.some(c => c.name === 'ชื่อลูกค้า'));
    });
  });

  // Combo 4: F10 (ATTACH String Generation) + F11 (DuckDB Execution) + F12 (Thai Query)
  describe('Combo 4: F10 (ATTACH Generation) + F11 (DuckDB Execution) + F12 (Thai Query)', () => {
    it('Generates cleaned DuckLake ATTACH string and executes DuckDB query against Thai lakehouse table', () => {
      const rawConn = `host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=WIN874`;
      // Clean connection string as done by extension.ts
      const cleaned = rawConn.replace(/\s*client_encoding=[^\s]+/gi, '').replace(/[?&]client_encoding=[^&#\s]*/gi, '').trim();
      assert.ok(!cleaned.includes('client_encoding'));

      const attachSql = `ATTACH 'ducklake:postgres:${cleaned} client_encoding=UTF8' AS lake;`;
      const queryScript = [
        'LOAD postgres;',
        'LOAD ducklake;',
        attachSql,
        'SHOW TABLES FROM lake;',
        'SELECT "ชื่อสินค้า", "ราคา" FROM lake."ตารางสินค้า" ORDER BY "รหัสสินค้า";'
      ].join('\n');

      const res = spawnSync('duckdb', ['-c', queryScript], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `DuckDB execution failed: ${res.stderr}`);
      assert.ok(res.stdout.includes('คอมพิวเตอร์พกพา'), `Expected คอมพิวเตอร์พกพา in stdout: ${res.stdout}`);
      assert.ok(res.stdout.includes('จอภาพความละเอียดสูง'), `Expected จอภาพความละเอียดสูง in stdout: ${res.stdout}`);
    });
  });

  // Combo 5: F2 (Isolated Daemon) + F6 (Connection Probe) + F14 (Safe Teardown)
  describe('Combo 5: F2 (Daemon) + F6 (Connection Probe) + F14 (Teardown)', () => {
    it('Executes clean lifecycle start, connection probe, and stop on secondary isolated port', async () => {
      const secondaryPort = await PgE2EHarness.findAvailablePort(54360);
      const secondaryDir = path.join(os.tmpdir(), `ducklake_pg_cycle_${Date.now()}`);
      const cycleHarness = new PgE2EHarness({
        port: secondaryPort,
        dataDir: secondaryDir,
        logFile: path.join(secondaryDir, 'server.log'),
        database: 'postgres'
      });

      cycleHarness.initCluster();
      await cycleHarness.startServer();
      assert.strictEqual(cycleHarness.started, true);

      const catClient = new PostgresCatalogClient(cycleHarness.getConnectionConfig());
      const res = await catClient.testConnection();
      assert.strictEqual(res.success, true);
      assert.ok(res.message.includes('WIN874'));

      await cycleHarness.stopServer();
      assert.strictEqual(cycleHarness.started, false);

      const available = await PgE2EHarness.isPortAvailable(secondaryPort);
      assert.strictEqual(available, true, `Port ${secondaryPort} must be released`);

      cycleHarness.cleanDataDir();
      assert.ok(!fs.existsSync(secondaryDir));
    });
  });

  // Combo 6: F4 (Thai Fixtures) + F9 (SchemaManager) + F10 (ATTACH Generation)
  describe('Combo 6: F4 (Thai Fixtures) + F9 (SchemaManager) + F10 (ATTACH Generation)', () => {
    it('Finds Thai table in SchemaManager and verifies connection config can generate valid attach string', async () => {
      const { setMockConfig, mockVscode } = require('./harness/vscodeShim');
      const { ConfigStorage } = require('../../dist/catalog/configStorage');
      const tempStorage = path.join(os.tmpdir(), `ducklake_combo6_${Date.now()}`);
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
        connectionName: 'production_lake',
        databaseAlias: 'production_lake',
        catalogType: 'server',
        dataPath: 'C:/data/lakehouse'
      };
      fs.writeFileSync(
        path.join(tempStorage, 'connections.json'),
        JSON.stringify({ version: 1, activeConnection: 'production_lake', connections: [testConfig] })
      );

      setMockConfig({
        'postgres.connectionString': connStr,
        'postgres.host': pgConfig.host,
        'postgres.port': pgConfig.port,
        'postgres.database': pgConfig.database,
        'postgres.user': pgConfig.user,
        'connectionName': 'production_lake',
        'databaseAlias': 'production_lake'
      });

      const sm = new SchemaManager();
      try {
        await sm.refreshCatalog(true);
        const thaiTable = sm.findTable('ตารางลูกค้า');
        assert.ok(thaiTable);

        // Generate ATTACH string using harness helper
        const attachStr = harness.getDuckDbAttachString('production_lake', 'C:/data/lakehouse');
        assert.ok(attachStr.includes('AS production_lake'));
        assert.ok(attachStr.includes("DATA_PATH 'C:/data/lakehouse'"));
      } finally {
        sm.dispose();
      }
    });
  });

  // Combo 7: F8 (Comment Resilience) + F9 (SchemaManager) + F11 (DuckDB Queries)
  describe('Combo 7: F8 (Comment Resilience) + F9 (SchemaManager) + F11 (DuckDB Queries)', () => {
    it('SchemaManager refreshes successfully while DuckDB simultaneously queries clean tables', async () => {
      const { setMockConfig, mockVscode } = require('./harness/vscodeShim');
      const { ConfigStorage } = require('../../dist/catalog/configStorage');
      const tempStorage = path.join(os.tmpdir(), `ducklake_combo7_${Date.now()}`);
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
        databaseAlias: 'lake'
      };
      fs.writeFileSync(
        path.join(tempStorage, 'connections.json'),
        JSON.stringify({ version: 1, activeConnection: 'lake', connections: [testConfig] })
      );

      setMockConfig({
        'postgres.connectionString': connStr,
        'postgres.host': pgConfig.host,
        'postgres.port': pgConfig.port,
        'postgres.database': pgConfig.database,
        'postgres.user': pgConfig.user
      });

      const sm = new SchemaManager();
      try {
        // Execute SchemaManager refresh and DuckDB query concurrently
        const [smResult, duckResult] = await Promise.all([
          (async () => {
            await sm.refreshCatalog(true);
            return sm.getTables().length;
          })(),
          (async () => {
            const q = `
              LOAD postgres;
              ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
              SELECT COUNT(*) as count FROM pg."ตารางลูกค้า";
            `;
            const r = spawnSync('duckdb', ['-c', q], { encoding: 'utf8' });
            return { status: r.status, stdout: r.stdout };
          })()
        ]);

        assert.ok(smResult >= 3, `SchemaManager should load tables: ${smResult}`);
        assert.strictEqual(duckResult.status, 0);
        assert.ok(duckResult.stdout.includes('3'));
      } finally {
        sm.dispose();
      }
    });
  });
});
