import * as assert from 'assert';
import { Client } from 'pg';
import * as path from 'path';
import { PgHarness } from './pgHarness';
import { PostgresCatalogClient } from '../../../src/catalog/postgresClient';

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: any;
}

const results: TestResult[] = [];

function record(name: string, fn: () => void | Promise<void>) {
  return async () => {
    try {
      await fn();
      results.push({ name, passed: true });
      console.log(`  [PASS] ${name}`);
    } catch (err: any) {
      results.push({ name, passed: false, error: err.message || String(err) });
      console.error(`  [FAIL] ${name}: ${err.message || err}`);
      throw err;
    }
  };
}

export async function runStressTest(): Promise<{ passed: boolean; results: TestResult[] }> {
  console.log('================================================================');
  console.log('CHALLENGER 2: EMPIRICAL STRESS TEST OF M1 FIXTURES & ENCODING');
  console.log('================================================================');

  const testPort = 5442; // Isolated port to avoid collision
  const dataDir = path.resolve(process.cwd(), 'test', '.pgdata_stress_test');

  const harness = new PgHarness({
    port: testPort,
    dataDir: dataDir,
    autoCleanDataDir: false,
    startupTimeoutMs: 15000,
  });

  let harnessStarted = false;

  try {
    console.log('\n--- PHASE 1: Harness Lifecycle & Cluster Init ---');
    await harness.start();
    harnessStarted = true;
    console.log(`✓ PostgreSQL 17 started on port ${testPort} (PID: ${harness.getStatus().pid})`);

    const client = new Client(harness.getConnectionConfig());
    await client.connect();

    try {
      // Step 1: Server encoding verification
      await record('Cluster server_encoding is WIN874', async () => {
        const encRes = await client.query('SHOW server_encoding;');
        assert.strictEqual(encRes.rows[0].server_encoding, 'WIN874');
      })();

      // Step 2: Seed all fixtures
      console.log('\n--- PHASE 2: Seed Fixtures ---');
      await record('Seed all fixtures via harness.seedFixtures()', async () => {
        await harness.seedFixtures();
      })();

      // Step 3: DuckLake Metastore Schema & Active Row Stress Testing
      console.log('\n--- PHASE 3: DuckLake Metastore Verification & Active Row Stress ---');

      await record('DuckLake DDL: 7 required metastore tables exist in pg_tables', async () => {
        const res = await client.query(`
          SELECT tablename FROM pg_tables 
          WHERE schemaname = 'public' AND tablename LIKE 'ducklake_%'
          ORDER BY tablename;
        `);
        const found = res.rows.map((r) => r.tablename);
        const expected = [
          'ducklake_column',
          'ducklake_metadata',
          'ducklake_schema',
          'ducklake_snapshot',
          'ducklake_table',
          'ducklake_table_stats',
          'ducklake_view'
        ];
        for (const exp of expected) {
          assert.ok(found.includes(exp), `Missing table: ${exp}. Found: ${found.join(', ')}`);
        }
      })();

      await record('DuckLake Schema: active schema "main" exists with path', async () => {
        const res = await client.query('SELECT * FROM ducklake_schema WHERE end_snapshot IS NULL;');
        assert.strictEqual(res.rows.length, 1);
        assert.strictEqual(res.rows[0].schema_name, 'main');
        assert.strictEqual(res.rows[0].schema_id, '0');
        assert.strictEqual(res.rows[0].path, 'main/');
        assert.strictEqual(res.rows[0].path_is_relative, true);
      })();

      await record('DuckLake Tables: active tables "customers" and "orders" exist', async () => {
        const res = await client.query('SELECT * FROM ducklake_table WHERE end_snapshot IS NULL ORDER BY table_id;');
        assert.strictEqual(res.rows.length, 2);
        assert.strictEqual(res.rows[0].table_name, 'customers');
        assert.strictEqual(res.rows[0].table_id, '1');
        assert.strictEqual(res.rows[1].table_name, 'orders');
        assert.strictEqual(res.rows[1].table_id, '2');
      })();

      await record('DuckLake Columns: active columns match expected names and ordering', async () => {
        const res1 = await client.query('SELECT * FROM ducklake_column WHERE table_id = 1 AND end_snapshot IS NULL ORDER BY column_order;');
        assert.strictEqual(res1.rows.length, 2);
        assert.strictEqual(res1.rows[0].column_name, 'customer_id');
        assert.strictEqual(res1.rows[0].column_type, 'int32');
        assert.strictEqual(res1.rows[1].column_name, 'customer_name');
        assert.strictEqual(res1.rows[1].column_type, 'varchar');

        const res2 = await client.query('SELECT * FROM ducklake_column WHERE table_id = 2 AND end_snapshot IS NULL ORDER BY column_order;');
        assert.strictEqual(res2.rows.length, 3);
        assert.strictEqual(res2.rows[0].column_name, 'order_id');
        assert.strictEqual(res2.rows[1].column_name, 'customer_id');
        assert.strictEqual(res2.rows[2].column_name, 'order_total');
      })();

      await record('DuckLake Views: active view "v_customers" exists with definition', async () => {
        const res = await client.query('SELECT * FROM ducklake_view WHERE end_snapshot IS NULL;');
        assert.strictEqual(res.rows.length, 1);
        assert.strictEqual(res.rows[0].view_name, 'v_customers');
        assert.strictEqual(res.rows[0].sql, 'SELECT * FROM main.customers');
      })();

      await record('DuckLake Table Stats: stats exist for active tables', async () => {
        const res = await client.query('SELECT * FROM ducklake_table_stats ORDER BY table_id;');
        assert.strictEqual(res.rows.length, 2);
        assert.strictEqual(res.rows[0].record_count, '500');
        assert.strictEqual(res.rows[0].file_size_bytes, '102400');
        assert.strictEqual(res.rows[1].record_count, '1250');
        assert.strictEqual(res.rows[1].file_size_bytes, '256000');
      })();

      await record('DuckLake Invariant Stress: inactive rows (end_snapshot IS NOT NULL) are filtered out', async () => {
        // Insert historical inactive table and column
        await client.query(`
          INSERT INTO ducklake_table (table_id, table_uuid, begin_snapshot, end_snapshot, schema_id, table_name, path, path_is_relative)
          VALUES (999, '99999999-9999-9999-9999-999999999999', 0, 1, 0, 'deprecated_table', 'deprecated/', true);
        `);
        await client.query(`
          INSERT INTO ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type)
          VALUES (999, 0, 1, 999, 1, 'old_col', 'varchar');
        `);

        // Check active tables query
        const activeTables = await client.query('SELECT table_name FROM ducklake_table WHERE end_snapshot IS NULL;');
        const names = activeTables.rows.map((r) => r.table_name);
        assert.ok(!names.includes('deprecated_table'), 'Historical table must not appear in active tables query');

        // Clean up
        await client.query('DELETE FROM ducklake_column WHERE column_id = 999;');
        await client.query('DELETE FROM ducklake_table WHERE table_id = 999;');
      })();

      // Step 4: Native Thai Tables, Columns, and Comments Stress Testing
      console.log('\n--- PHASE 4: Native Thai Tables, Columns, and Comments Stress ---');

      await record('Native Thai Tables: "ตารางลูกค้า" and "คำสั่งซื้อ" exist in information_schema', async () => {
        const res = await client.query(`
          SELECT table_name FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name IN ('ตารางลูกค้า', 'คำสั่งซื้อ')
          ORDER BY table_name;
        `);
        assert.strictEqual(res.rows.length, 2);
        const tNames = res.rows.map((r) => r.table_name);
        assert.ok(tNames.includes('ตารางลูกค้า'));
        assert.ok(tNames.includes('คำสั่งซื้อ'));
      })();

      await record('Native Thai Columns: verify all column identifiers match verbatim Thai text', async () => {
        const resCust = await client.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'ตารางลูกค้า'
          ORDER BY ordinal_position;
        `);
        const custCols = resCust.rows.map((r) => r.column_name);
        assert.deepStrictEqual(custCols, ['รหัสลูกค้า', 'ชื่อลูกค้า', 'ยอดสั่งซื้อ']);

        const resOrd = await client.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'คำสั่งซื้อ'
          ORDER BY ordinal_position;
        `);
        const ordCols = resOrd.rows.map((r) => r.column_name);
        assert.deepStrictEqual(ordCols, ['รหัสคำสั่งซื้อ', 'รหัสลูกค้า', 'วันที่สั่งซื้อ', 'จำนวนเงิน']);
      })();

      await record('Native Thai Comments: obj_description verifies table comments verbatim', async () => {
        const resCust = await client.query(`
          SELECT obj_description(c.oid, 'pg_class') as comment
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'ตารางลูกค้า' AND n.nspname = 'public';
        `);
        assert.strictEqual(resCust.rows[0].comment, 'ตารางลูกค้าของบริษัท');

        const resOrd = await client.query(`
          SELECT obj_description(c.oid, 'pg_class') as comment
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = 'คำสั่งซื้อ' AND n.nspname = 'public';
        `);
        assert.strictEqual(resOrd.rows[0].comment, 'รายการคำสั่งซื้อสินค้า');
      })();

      await record('Native Thai Comments: col_description verifies all 7 column comments verbatim', async () => {
        const expectedCustColComments: Record<number, string> = {
          1: 'รหัสประจำตัวลูกค้า',
          2: 'ชื่อและนามสกุลลูกค้า',
          3: 'ยอดสั่งซื้อสะสม',
        };
        for (const [pos, exp] of Object.entries(expectedCustColComments)) {
          const res = await client.query(`
            SELECT col_description(c.oid, ${pos}) as comment
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = 'ตารางลูกค้า' AND n.nspname = 'public';
          `);
          assert.strictEqual(res.rows[0].comment, exp, `Col ${pos} of ตารางลูกค้า comment mismatch`);
        }

        const expectedOrdColComments: Record<number, string> = {
          1: 'รหัสใบสั่งซื้อสินค้า',
          2: 'รหัสลูกค้าผู้ออกคำสั่งซื้อ',
          3: 'วันที่ทำรายการ',
          4: 'จำนวนเงินรวมของคำสั่งซื้อ',
        };
        for (const [pos, exp] of Object.entries(expectedOrdColComments)) {
          const res = await client.query(`
            SELECT col_description(c.oid, ${pos}) as comment
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = 'คำสั่งซื้อ' AND n.nspname = 'public';
          `);
          assert.strictEqual(res.rows[0].comment, exp, `Col ${pos} of คำสั่งซื้อ comment mismatch`);
        }
      })();

      await record('Native Thai Data: sample data rows query and match verbatim Thai strings', async () => {
        const resCust = await client.query('SELECT * FROM "ตารางลูกค้า" ORDER BY "รหัสลูกค้า";');
        assert.strictEqual(resCust.rows.length, 2);
        assert.strictEqual(resCust.rows[0]['รหัสลูกค้า'], 1);
        assert.strictEqual(resCust.rows[0]['ชื่อลูกค้า'], 'สมชาย สถิต');
        assert.strictEqual(resCust.rows[1]['รหัสลูกค้า'], 2);
        assert.strictEqual(resCust.rows[1]['ชื่อลูกค้า'], 'วิภา ประเสริฐ');

        const resOrd = await client.query('SELECT * FROM "คำสั่งซื้อ" ORDER BY "รหัสคำสั่งซื้อ";');
        assert.strictEqual(resOrd.rows.length, 2);
        assert.strictEqual(resOrd.rows[0]['รหัสคำสั่งซื้อ'], 101);
        assert.strictEqual(resOrd.rows[1]['รหัสคำสั่งซื้อ'], 102);
      })();

      await record('Native Thai Stress: insertion of complex tone marks and combining chars', async () => {
        await client.query(`
          INSERT INTO "ตารางลูกค้า" ("รหัสลูกค้า", "ชื่อลูกค้า", "ยอดสั่งซื้อ")
          VALUES (99, 'ผู้ใหญ่บ้าน น้ำตาล เก้าอี้ โต๊ะ', 999.99);
        `);
        const res = await client.query('SELECT "ชื่อลูกค้า" FROM "ตารางลูกค้า" WHERE "รหัสลูกค้า" = 99;');
        assert.strictEqual(res.rows[0]['ชื่อลูกค้า'], 'ผู้ใหญ่บ้าน น้ำตาล เก้าอี้ โต๊ะ');
        await client.query('DELETE FROM "ตารางลูกค้า" WHERE "รหัสลูกค้า" = 99;');
      })();

      // Step 5: Fault Injection Fixture & Encoding Behavior Stress Testing
      console.log('\n--- PHASE 5: Fault Injection Fixture & Encoding Behavior (UTF-8 vs WIN874) ---');

      await record('Fault Injection: test_corrupt_comments table exists', async () => {
        const res = await client.query(`
          SELECT table_name FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = 'test_corrupt_comments';
        `);
        assert.strictEqual(res.rows.length, 1);
      })();

      await record('Fault Injection Under UTF-8: obj_description triggers error 22P05', async () => {
        await client.query("SET client_encoding = 'UTF8';");
        let threw = false;
        let errCode = '';
        let errMsg = '';
        try {
          await client.query(`
            SELECT obj_description(c.oid, 'pg_class') as comment
            FROM pg_class c WHERE c.relname = 'test_corrupt_comments';
          `);
        } catch (err: any) {
          threw = true;
          errCode = err.code;
          errMsg = err.message;
        } finally {
          await client.query("SET client_encoding = 'WIN874';");
        }

        assert.strictEqual(threw, true, 'Querying corrupt comment under UTF-8 must throw');
        assert.strictEqual(errCode, '22P05', `Expected SQLSTATE 22P05, got ${errCode}`);
        assert.ok(
          errMsg.includes('character with byte sequence 0xdb in encoding "WIN874" has no equivalent in encoding "UTF8"'),
          `Unexpected error message: ${errMsg}`
        );
      })();

      await record('Fault Injection Under UTF-8: col_description triggers error 22P05', async () => {
        await client.query("SET client_encoding = 'UTF8';");
        let threw = false;
        let errCode = '';
        let errMsg = '';
        try {
          await client.query(`
            SELECT col_description(c.oid, 2) as comment
            FROM pg_class c WHERE c.relname = 'test_corrupt_comments';
          `);
        } catch (err: any) {
          threw = true;
          errCode = err.code;
          errMsg = err.message;
        } finally {
          await client.query("SET client_encoding = 'WIN874';");
        }

        assert.strictEqual(threw, true, 'Querying corrupt col comment under UTF-8 must throw');
        assert.strictEqual(errCode, '22P05', `Expected SQLSTATE 22P05, got ${errCode}`);
      })();

      await record('Fault Injection Under UTF-8: information_schema with obj_description triggers 22P05', async () => {
        await client.query("SET client_encoding = 'UTF8';");
        let threw = false;
        let errCode = '';
        try {
          await client.query(`
            SELECT t.table_name, obj_description(c.oid, 'pg_class')
            FROM information_schema.tables t
            JOIN pg_class c ON c.relname = t.table_name
            WHERE t.table_schema = 'public';
          `);
        } catch (err: any) {
          threw = true;
          errCode = err.code;
        } finally {
          await client.query("SET client_encoding = 'WIN874';");
        }

        assert.strictEqual(threw, true, 'Querying all table comments under UTF-8 must trigger 22P05 due to corrupt fixture');
        assert.strictEqual(errCode, '22P05');
      })();

      await record('Fault Injection Under WIN874: obj_description SUCCEEDS without error', async () => {
        await client.query("SET client_encoding = 'WIN874';");
        const res = await client.query(`
          SELECT obj_description(c.oid, 'pg_class') as comment
          FROM pg_class c WHERE c.relname = 'test_corrupt_comments';
        `);
        assert.strictEqual(res.rows.length, 1);
        const val = res.rows[0].comment;
        assert.ok(val !== undefined && val !== null, 'Comment should be returned');
        assert.ok(val.includes('Corrupt Thai'), `Expected prefix 'Corrupt Thai', got: ${val}`);
      })();

      await record('Fault Injection Under WIN874: col_description SUCCEEDS without error', async () => {
        await client.query("SET client_encoding = 'WIN874';");
        const res = await client.query(`
          SELECT col_description(c.oid, 2) as comment
          FROM pg_class c WHERE c.relname = 'test_corrupt_comments';
        `);
        assert.strictEqual(res.rows.length, 1);
        const val = res.rows[0].comment;
        assert.ok(val !== undefined && val !== null, 'Col comment should be returned');
        assert.ok(val.includes('Corrupt column'), `Expected prefix 'Corrupt column', got: ${val}`);
      })();

      await record('Fault Injection Under WIN874: all tables query SUCCEEDS without error', async () => {
        await client.query("SET client_encoding = 'WIN874';");
        const res = await client.query(`
          SELECT t.table_name, obj_description(c.oid, 'pg_class') as comment
          FROM information_schema.tables t
          JOIN pg_class c ON c.relname = t.table_name
          WHERE t.table_schema = 'public'
          ORDER BY t.table_name;
        `);
        assert.ok(res.rows.length >= 3);
        const corruptRow = res.rows.find((r) => r.table_name === 'test_corrupt_comments');
        assert.ok(corruptRow, 'test_corrupt_comments must be in result set');
        assert.ok(corruptRow.comment.includes('Corrupt Thai'));
      })();

      await record('Fault Injection Under SQL_ASCII: obj_description SUCCEEDS without error', async () => {
        await client.query("SET client_encoding = 'SQL_ASCII';");
        const res = await client.query(`
          SELECT obj_description(c.oid, 'pg_class') as comment
          FROM pg_class c WHERE c.relname = 'test_corrupt_comments';
        `);
        assert.strictEqual(res.rows.length, 1);
        assert.ok(res.rows[0].comment.includes('Corrupt Thai'));
        await client.query("SET client_encoding = 'WIN874';");
      })();

      // Step 6: End-to-End Resilience with PostgresCatalogClient
      console.log('\n--- PHASE 6: End-to-End Resilience via PostgresCatalogClient ---');

      function createCatClient(): PostgresCatalogClient {
        return new PostgresCatalogClient({
          host: harness.host,
          port: harness.port,
          database: harness.database,
          user: harness.user,
          password: harness.password,
          ssl: false,
          catalogSchemas: ['public'],
          autoRefreshMinutes: 0,
          enableSmartHeuristic: false,
          suggestDuckDBFunctions: false,
          alwaysEnableInTripleQuotes: false,
          clientEncoding: 'auto',
        });
      }

      await record('PostgresCatalogClient: testConnection() auto-detects WIN874 and DuckLake metastore', async () => {
        const catClient = createCatClient();
        const connRes = await catClient.testConnection();
        assert.strictEqual(connRes.success, true);
        assert.ok(connRes.message.includes('WIN874'), `Message should include WIN874: ${connRes.message}`);
        assert.ok(connRes.message.includes('DuckLake Metastore detected'), `Message should detect DuckLake: ${connRes.message}`);
      })();

      await record('PostgresCatalogClient: fetchCatalog() retrieves both DuckLake & Thai tables cleanly', async () => {
        const catClient = createCatClient();
        const catalog = await catClient.fetchCatalog();
        const fullNames = catalog.map((t) => t.fullName);
        console.log(`    Retrieved catalog tables: ${fullNames.join(', ')}`);

        // Check DuckLake tables
        assert.ok(fullNames.includes('main.customers'), 'main.customers missing');
        assert.ok(fullNames.includes('main.orders'), 'main.orders missing');
        assert.ok(fullNames.includes('main.v_customers'), 'main.v_customers missing');

        // Check native Thai tables
        assert.ok(fullNames.includes('public.ตารางลูกค้า'), 'public.ตารางลูกค้า missing');
        assert.ok(fullNames.includes('public.คำสั่งซื้อ'), 'public.คำสั่งซื้อ missing');

        // Check columns of public.ตารางลูกค้า
        const thaiTable = catalog.find((t) => t.fullName === 'public.ตารางลูกค้า')!;
        assert.ok(thaiTable, 'public.ตารางลูกค้า should be in catalog');
        const colNames = thaiTable.columns.map((c) => c.name);
        assert.deepStrictEqual(colNames, ['รหัสลูกค้า', 'ชื่อลูกค้า', 'ยอดสั่งซื้อ']);
        assert.strictEqual(thaiTable.comment, 'ตารางลูกค้าของบริษัท');

        // Check corrupt table exists in catalog without crashing
        assert.ok(fullNames.includes('public.test_corrupt_comments'), 'public.test_corrupt_comments should be in catalog');
      })();

      // Step 6b: Forced UTF8 with PostgresCatalogClient (Testing Fallback Recovery)
      await record('PostgresCatalogClient Fallback: fetchCatalog() succeeds even when clientEncoding is forced to UTF8', async () => {
        const utf8Client = new PostgresCatalogClient({
          host: harness.host,
          port: harness.port,
          database: harness.database,
          user: harness.user,
          password: harness.password,
          ssl: false,
          catalogSchemas: ['public'],
          autoRefreshMinutes: 0,
          enableSmartHeuristic: false,
          suggestDuckDBFunctions: false,
          alwaysEnableInTripleQuotes: false,
          clientEncoding: 'UTF8',
        });
        // With clientEncoding='UTF8', queryWithFallback should intercept 22P05 or
        // pgTablesQuery/pgColumnsQuery should catch and fallback to safe queries without comments!
        const catalog = await utf8Client.fetchCatalog();
        const fullNames = catalog.map((t) => t.fullName);
        assert.ok(fullNames.includes('main.customers'), 'main.customers missing under forced UTF8');
        assert.ok(fullNames.includes('public.ตารางลูกค้า'), 'public.ตารางลูกค้า missing under forced UTF8');
        assert.ok(fullNames.includes('public.test_corrupt_comments'), 'public.test_corrupt_comments missing under forced UTF8');
      })();

      // Step 6c: Idempotency & Query Encoding Behavior
      console.log('\n--- PHASE 6c: Fixture Idempotency & Query Encoding Behavior ---');
      await record('Fixture Idempotency: re-seeding fixtures on already seeded database succeeds cleanly', async () => {
        await harness.seedFixtures();
        // DuckLake tables (ASCII names) succeed under any client_encoding
        const resTables = await client.query('SELECT COUNT(*) as cnt FROM ducklake_table WHERE end_snapshot IS NULL;');
        assert.strictEqual(resTables.rows[0].cnt, '2');
      })();

      await record('Empirical Insight: querying Thai literal in SQL under WIN874 vs UTF-8', async () => {
        // Under client_encoding='WIN874', node-postgres sends UTF-8 wire bytes for query text,
        // which PG parses as WIN874 mojibake (เธ•เธฒเธฃเธฒเธ‡...).
        await client.query("SET client_encoding = 'WIN874';");
        let threwUnderWin874 = false;
        try {
          await client.query('SELECT COUNT(*) as cnt FROM "ตารางลูกค้า";');
        } catch (err: any) {
          threwUnderWin874 = true;
          // Expect 42P01: relation does not exist due to UTF-8 bytes parsed as WIN874
          assert.strictEqual(err.code, '42P01');
          assert.ok(err.message.includes('does not exist'));
        }
        assert.strictEqual(threwUnderWin874, true, 'Thai table query under WIN874 without wire transcoder must fail');

        // Under client_encoding='UTF8', PG transcodes query text UTF-8 -> WIN874 seamlessly!
        await client.query("SET client_encoding = 'UTF8';");
        const resCustUtf8 = await client.query('SELECT COUNT(*) as cnt FROM "ตารางลูกค้า";');
        assert.strictEqual(resCustUtf8.rows[0].cnt, '2', 'Thai table query under UTF-8 must succeed');

        // Restore to WIN874 for subsequent tests
        await client.query("SET client_encoding = 'WIN874';");
      })();

      // Step 6d: Concurrency stress test
      console.log('\n--- PHASE 6d: Parallel Concurrency Stress ---');
      await record('Concurrency: 10 parallel queries on Thai and DuckLake tables execute concurrently', async () => {
        const pool = Array.from({ length: 5 }, () => new Client(harness.getConnectionConfig()));
        await Promise.all(pool.map((c) => c.connect()));
        try {
          const promises = [];
          for (let i = 0; i < 10; i++) {
            const cl = pool[i % pool.length];
            if (i % 2 === 0) {
              promises.push(cl.query('SELECT * FROM "ตารางลูกค้า";'));
            } else {
              promises.push(cl.query('SELECT * FROM ducklake_table WHERE end_snapshot IS NULL;'));
            }
          }
          const results = await Promise.all(promises);
          assert.strictEqual(results.length, 10);
          for (const res of results) {
            assert.ok(res.rows.length >= 2);
          }
        } finally {
          await Promise.all(pool.map((c) => c.end()));
        }
      })();

    } finally {
      await client.end();
    }

    // Step 7: Restart and Teardown verification
    console.log('\n--- PHASE 7: Teardown, Immediate Restart, & Zero Orphan Verification ---');
    await record('PgHarness stop cleanly terminates server with zero orphans', async () => {
      const pid = harness.getStatus().pid!;
      await harness.stop();
      harnessStarted = false;
      assert.strictEqual(harness.getStatus().isRunning, false);
      assert.strictEqual(harness.isProcessAlive(pid), false);
    })();

    await record('PgHarness immediate restart on same dataDir succeeds', async () => {
      // Create harness without autoCleanDataDir so data remains
      const restartHarness = new PgHarness({
        port: testPort,
        dataDir: dataDir,
        autoCleanDataDir: true,
        startupTimeoutMs: 15000,
      });
      await restartHarness.start();
      assert.strictEqual(restartHarness.getStatus().isRunning, true);
      const probeClient = new Client(restartHarness.getConnectionConfig());
      await probeClient.connect();
      try {
        const res = await probeClient.query('SELECT COUNT(*) as cnt FROM ducklake_table WHERE end_snapshot IS NULL;');
        assert.strictEqual(res.rows[0].cnt, '2');
      } finally {
        await probeClient.end();
        await restartHarness.stop();
      }
    })();

  } catch (err) {
    console.error('Stress test encountered an error:', err);
    if (harnessStarted) {
      try {
        await harness.stop();
      } catch (_) {}
    }
    return { passed: false, results };
  }

  const allPassed = results.every((r) => r.passed);
  console.log('\n================================================================');
  console.log(`STRESS TEST SUMMARY: ${results.filter((r) => r.passed).length}/${results.length} PASSED`);
  console.log(`OVERALL VERDICT: ${allPassed ? 'ALL ASSERTIONS PASSED' : 'FAILURES DETECTED'}`);
  console.log('================================================================\n');

  return { passed: allPassed, results };
}

if (require.main === module) {
  runStressTest().then((res) => {
    process.exit(res.passed ? 0 : 1);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
