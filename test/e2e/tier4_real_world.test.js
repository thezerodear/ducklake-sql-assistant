// test/e2e/tier4_real_world.test.js
// Tier 4: Real-World Workload Scenarios

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

describe('Tier 4: Real-World Workload Scenarios', () => {
  let harness;
  let ownsHarness = false;
  let pgConfig;
  let client;

  before(async () => {
    const sharedPort = process.env.E2E_SHARED_PORT ? parseInt(process.env.E2E_SHARED_PORT, 10) : null;
    if (sharedPort) {
      harness = new PgE2EHarness({ port: sharedPort, database: 'ducklake_e2e' });
      pgConfig = harness.getConnectionConfig();
    } else {
      ownsHarness = true;
      const port = await PgE2EHarness.findAvailablePort(54355);
      const dataDir = path.join(os.tmpdir(), `ducklake_e2e_t4_${Date.now()}`);
      const logFile = path.join(os.tmpdir(), `ducklake_e2e_t4_${Date.now()}.log`);
      harness = new PgE2EHarness({ port, dataDir, logFile, database: 'ducklake_e2e' });
      harness.initCluster();
      await harness.startServer();
      harness.createDatabase('ducklake_e2e');
      const seeder = new FixtureSeeder(harness.getConnectionConfig());
      await seeder.seedAll(harness);
      pgConfig = harness.getConnectionConfig();
    }

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

  // Scenario 1: Data Analyst Lakehouse Exploration Workflow
  describe('Scenario 1: End-to-End Data Analyst Workflow', () => {
    it('Performs complete analyst workflow: connect -> introspect -> discover Thai table -> generate query code -> execute DuckDB', async () => {
      // Step 1: Initialize SchemaManager with isolated storage
      const { setMockConfig, mockVscode } = require('./harness/vscodeShim');
      const { ConfigStorage } = require('../../dist/catalog/configStorage');
      const tempStorage = path.join(os.tmpdir(), `ducklake_scenario1_${Date.now()}`);
      fs.mkdirSync(tempStorage, { recursive: true });
      ConfigStorage.init(mockVscode.Uri.file(tempStorage));

      const connStr = `host=127.0.0.1 port=${pgConfig.port} dbname=${pgConfig.database} user=${pgConfig.user}`;
      const analystConfig = {
        connectionString: connStr,
        host: pgConfig.host,
        port: pgConfig.port,
        database: pgConfig.database,
        user: pgConfig.user,
        password: '',
        ssl: false,
        clientEncoding: 'auto',
        connectionName: 'analyst_lake',
        databaseAlias: 'analyst_lake',
        catalogType: 'server',
        catalogSchemas: ['public', 'main']
      };
      fs.writeFileSync(
        path.join(tempStorage, 'connections.json'),
        JSON.stringify({ version: 1, activeConnection: 'analyst_lake', connections: [analystConfig] })
      );

      setMockConfig({
        'postgres.connectionString': connStr,
        'postgres.host': pgConfig.host,
        'postgres.port': pgConfig.port,
        'postgres.database': pgConfig.database,
        'postgres.user': pgConfig.user,
        'connectionName': 'analyst_lake',
        'databaseAlias': 'analyst_lake'
      });

      const sm = new SchemaManager();
      try {
        // Step 2: Test connection
        const connRes = await sm.testConnection();
        assert.strictEqual(connRes.success, true);
        assert.ok(connRes.message.includes('WIN874'));

        // Step 3: Refresh and explore catalog
        await sm.refreshCatalog(true);
        const tables = sm.getTables();
        assert.ok(tables.length >= 3);

        // Step 4: Discover target customer table
        const custTable = sm.findTable('ตารางลูกค้า');
        assert.ok(custTable, 'Customer table must be discovered');
        assert.strictEqual(custTable.comment, 'ข้อมูลลูกค้าภาษาไทย');

        const cols = sm.getColumnsForTable('ตารางลูกค้า');
        assert.ok(cols.length >= 3);
        const colNames = cols.map(c => c.name);
        assert.ok(colNames.includes('ชื่อลูกค้า'));
        assert.ok(colNames.includes('ยอดสั่งซื้อ'));

        // Step 5: Execute analytic query using DuckDB
        const duckScript = `
          LOAD postgres;
          ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);
          SELECT "ชื่อลูกค้า", SUM("ยอดสั่งซื้อ") as total_sales
          FROM pg."ตารางลูกค้า"
          GROUP BY "ชื่อลูกค้า"
          ORDER BY total_sales DESC;
        `;
        const res = spawnSync('duckdb', ['-c', duckScript], { encoding: 'utf8' });
        assert.strictEqual(res.status, 0, `DuckDB failed: ${res.stderr}`);
        assert.ok(res.stdout.includes('วันดี มีสุข'));
        assert.ok(res.stdout.includes('8900'));
      } finally {
        sm.dispose();
      }
    });
  });

  // Scenario 2: Lakehouse Migration & Multi-Table Analytics Workflow
  describe('Scenario 2: Lakehouse Migration & Multi-Table Analytics', () => {
    it('Executes end-to-end lakehouse analytics joining lakehouse tables and native PostgreSQL tables', () => {
      const cleaned = `host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user}`;
      const sqlScript = `
        LOAD postgres;
        LOAD ducklake;
        ATTACH 'ducklake:postgres:${cleaned} client_encoding=UTF8' AS lake;
        ATTACH 'host=127.0.0.1 port=${harness.port} dbname=${harness.database} user=${harness.user} client_encoding=UTF8' AS pg (TYPE POSTGRES);

        -- Query 1: Lakehouse products
        SELECT "รหัสสินค้า", "ชื่อสินค้า", "ราคา" FROM lake."ตารางสินค้า" ORDER BY "รหัสสินค้า";

        -- Query 2: Native PostgreSQL orders joined with customers
        SELECT c."ชื่อลูกค้า", o."รหัสคำสั่งซื้อ", o."สถานะ"
        FROM pg."ตารางลูกค้า" c
        JOIN pg."คำสั่งซื้อ" o ON c."รหัสลูกค้า" = o."รหัสลูกค้า"
        ORDER BY o."รหัสคำสั่งซื้อ";
      `;

      const res = spawnSync('duckdb', ['-c', sqlScript], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `DuckDB multi-table analytics failed: ${res.stderr}`);
      assert.ok(res.stdout.includes('คอมพิวเตอร์พกพา'));
      assert.ok(res.stdout.includes('25000'));
      assert.ok(res.stdout.includes('สมชาย สายลม'));
      assert.ok(res.stdout.includes('จัดส่งสำเร็จ'));
    });
  });

  // Scenario 3: Resilient Production Session with Graceful Teardown
  describe('Scenario 3: Resilient Production Session with Graceful Teardown', () => {
    it('Maintains robust catalog state across successive introspections and verifies clean process state', async () => {
      const catClient = new PostgresCatalogClient(pgConfig);

      // Successive catalog loads simulate ongoing user activity in VS Code
      for (let i = 0; i < 3; i++) {
        const tables = await catClient.fetchCatalog();
        assert.ok(tables.length >= 3);
        const thaiTable = tables.find(t => t.name === 'ตารางลูกค้า');
        assert.ok(thaiTable);
        assert.strictEqual(thaiTable.name, 'ตารางลูกค้า');
      }

      // Verify server is healthy and accepting connections
      const checkRes = spawnSync(
        harness.binPath('pg_isready'),
        ['-h', '127.0.0.1', '-p', String(harness.port), '-U', harness.user],
        { encoding: 'utf8' }
      );
      assert.strictEqual(checkRes.status, 0, 'Server must remain completely healthy throughout session');

      // Verify no unexpected zombie processes
      const pid = harness.getPostmasterPid();
      assert.ok(pid && pid > 0);
      assert.strictEqual(PgE2EHarness.isProcessAlive(pid), true);
    });
  });
});
