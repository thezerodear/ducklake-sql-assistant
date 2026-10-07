import * as assert from 'assert';
import { Client } from 'pg';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { PgHarness } from './pgHarness';

async function runVerification(): Promise<void> {
  console.log('=== Starting PostgreSQL 17 Test Harness Verification ===');

  const testPort = parseInt(process.env.PGPORT || '5439', 10);
  const dataDir = path.resolve(process.cwd(), 'test', '.pgdata_verify');

  const harness = new PgHarness({
    port: testPort,
    dataDir: dataDir,
    autoCleanDataDir: true,
  });

  console.log(`Detected PostgreSQL 17 Binaries at: ${harness.binDir}`);
  console.log(`Target Test Port: ${testPort}`);
  console.log(`Target Data Directory: ${dataDir}`);

  let serverStarted = false;

  try {
    // 1. Start the server (will run initdb if needed and start pg_ctl)
    console.log('\n[Step 1] Starting PostgreSQL 17 server...');
    const startTime = Date.now();
    await harness.start();
    serverStarted = true;
    const elapsed = Date.now() - startTime;

    const status = harness.getStatus();
    console.log(`✓ Server started in ${elapsed}ms. PID: ${status.pid}`);
    assert.strictEqual(status.isRunning, true, 'Harness should report running status');
    assert.ok(status.pid && status.pid > 0, 'Harness should hold valid PID');
    assert.strictEqual(harness.isProcessAlive(status.pid!), true, 'Process should be alive');

    // 2. Direct pg_isready verification
    console.log('\n[Step 2] Probing server readiness via pg_isready.exe...');
    const isReadyRes = spawnSync(path.join(harness.binDir, 'pg_isready.exe'), [
      '-h', harness.host,
      '-p', String(harness.port),
      '-U', harness.user,
    ], { encoding: 'utf-8', windowsHide: true });
    assert.strictEqual(isReadyRes.status, 0, `pg_isready failed: ${isReadyRes.stderr || isReadyRes.stdout}`);
    console.log('✓ pg_isready confirmed accepting connections (exit code 0)');

    // 3. Connect via node-postgres and verify initial encoding
    console.log('\n[Step 3] Verifying server_encoding in PostgreSQL...');
    const client = new Client(harness.getConnectionConfig());
    await client.connect();

    try {
      const encRes = await client.query('SHOW server_encoding;');
      const serverEncoding = encRes.rows[0].server_encoding;
      console.log(`✓ Active server_encoding: ${serverEncoding}`);
      assert.strictEqual(serverEncoding, 'WIN874', 'Cluster should be initialized with WIN874 encoding');

      // 4. Seed fixtures
      console.log('\n[Step 4] Seeding DuckLake metastore, Thai tables, and corrupt comments...');
      await harness.seedFixtures();
      console.log('✓ Fixtures seeded successfully');

      // 5. Verify DuckLake metastore tables
      console.log('\n[Step 5] Verifying DuckLake schema tables and active rows...');
      const schemaRes = await client.query('SELECT schema_name FROM ducklake_schema WHERE end_snapshot IS NULL;');
      assert.ok(schemaRes.rows.some((r) => r.schema_name === 'main'), 'DuckLake schema main missing');

      const tablesRes = await client.query('SELECT table_name FROM ducklake_table WHERE end_snapshot IS NULL ORDER BY table_name;');
      const tableNames = tablesRes.rows.map((r) => r.table_name);
      console.log(`✓ DuckLake tables found: ${tableNames.join(', ')}`);
      assert.ok(tableNames.includes('customers'), 'ducklake_table customers missing');
      assert.ok(tableNames.includes('orders'), 'ducklake_table orders missing');

      const colsRes = await client.query("SELECT column_name FROM ducklake_column WHERE table_id = 1 AND end_snapshot IS NULL ORDER BY column_order;");
      const colNames = colsRes.rows.map((r) => r.column_name);
      console.log(`✓ DuckLake columns for customers: ${colNames.join(', ')}`);
      assert.deepStrictEqual(colNames, ['customer_id', 'customer_name']);

      const viewRes = await client.query('SELECT view_name, sql FROM ducklake_view WHERE end_snapshot IS NULL;');
      console.log(`✓ DuckLake view found: ${viewRes.rows[0]?.view_name}`);
      assert.strictEqual(viewRes.rows[0]?.view_name, 'v_customers');

      const statsRes = await client.query('SELECT record_count, file_size_bytes FROM ducklake_table_stats WHERE table_id = 1;');
      console.log(`✓ DuckLake table stats: ${statsRes.rows[0]?.record_count} rows, ${statsRes.rows[0]?.file_size_bytes} bytes`);
      assert.strictEqual(statsRes.rows[0]?.record_count, '500');

      // 6. Verify native Thai tables and columns
      console.log('\n[Step 6] Verifying native Thai tables and Thai columns...');
      const thaiTablesRes = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name IN ('ตารางลูกค้า', 'คำสั่งซื้อ')
        ORDER BY table_name;
      `);
      const thaiTableNames = thaiTablesRes.rows.map((r) => r.table_name);
      console.log(`✓ Native Thai tables: ${thaiTableNames.join(', ')}`);
      assert.ok(thaiTableNames.includes('ตารางลูกค้า'), 'Native Thai table ตารางลูกค้า missing');
      assert.ok(thaiTableNames.includes('คำสั่งซื้อ'), 'Native Thai table คำสั่งซื้อ missing');

      const thaiColsRes = await client.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'ตารางลูกค้า'
        ORDER BY ordinal_position;
      `);
      const thaiCols = thaiColsRes.rows.map((r) => r.column_name);
      console.log(`✓ Columns of ตารางลูกค้า: ${thaiCols.join(', ')}`);
      assert.deepStrictEqual(thaiCols, ['รหัสลูกค้า', 'ชื่อลูกค้า', 'ยอดสั่งซื้อ']);

      // 7. Verify Thai obj_description and col_description comments
      console.log('\n[Step 7] Verifying Thai comments (obj_description & col_description)...');
      const tableCommentRes = await client.query(`
        SELECT obj_description(c.oid, 'pg_class') AS table_comment
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'ตารางลูกค้า' AND n.nspname = 'public';
      `);
      const tblComment = tableCommentRes.rows[0]?.table_comment;
      console.log(`✓ Table comment: "${tblComment}"`);
      assert.strictEqual(tblComment, 'ตารางลูกค้าของบริษัท');

      const colCommentRes = await client.query(`
        SELECT col_description(c.oid, 2) AS col_comment
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'ตารางลูกค้า' AND n.nspname = 'public';
      `);
      const colComment = colCommentRes.rows[0]?.col_comment;
      console.log(`✓ Column comment: "${colComment}"`);
      assert.strictEqual(colComment, 'ชื่อและนามสกุลลูกค้า');

      // 8. Verify corrupt comment fault injection
      console.log('\n[Step 8] Verifying corrupt comment fixture with byte \\xdb...');
      // Under client_encoding='UTF8', querying obj_description for test_corrupt_comments
      // must trigger PostgreSQL error 22P05 (character with byte sequence 0xdb in encoding WIN874 has no equivalent in encoding UTF8)
      await client.query("SET client_encoding = 'UTF8';");
      let threwExpectedError = false;
      try {
        await client.query(`
          SELECT obj_description(c.oid, 'pg_class') AS comment
          FROM pg_class c
          WHERE c.relname = 'test_corrupt_comments';
        `);
      } catch (err: any) {
        console.log(`✓ Received expected fault under UTF-8: [SQLSTATE ${err.code}] ${err.message}`);
        assert.ok(
          err.code === '22P05' || err.message.includes('no equivalent in encoding') || err.message.includes('0xdb'),
          `Unexpected error code: ${err.code} / ${err.message}`
        );
        threwExpectedError = true;
      }
      assert.strictEqual(threwExpectedError, true, 'Corrupt comment must trigger 22P05 under UTF-8');

      // Reset client encoding back to WIN874
      await client.query("SET client_encoding = 'WIN874';");

      // 9. Verify getDuckDbAttachString
      console.log('\n[Step 9] Verifying DuckDB ATTACH generation...');
      const attachStr = harness.getDuckDbAttachString('lake', 'C:\\temp\\lake_data');
      console.log(`✓ Generated ATTACH string: ${attachStr}`);
      assert.strictEqual(
        attachStr,
        `ATTACH 'ducklake:postgres:host=127.0.0.1 port=${testPort} dbname=postgres user=postgres' AS lake (DATA_PATH 'C:/temp/lake_data');`
      );

    } finally {
      await client.end();
    }

    // 10. Clean teardown and process check
    console.log('\n[Step 10] Stopping PostgreSQL 17 server and verifying 0 orphans...');
    const pidToVerify = harness.getStatus().pid!;
    await harness.stop();
    serverStarted = false;

    assert.strictEqual(harness.getStatus().isRunning, false, 'Harness should report stopped status');
    assert.strictEqual(harness.isProcessAlive(pidToVerify), false, 'Process should not be alive');

    // Confirm pg_isready fails now that server is stopped
    const probeAfterStop = spawnSync(path.join(harness.binDir, 'pg_isready.exe'), [
      '-h', harness.host,
      '-p', String(harness.port),
      '-U', harness.user,
    ], { stdio: 'ignore', windowsHide: true });
    assert.notStrictEqual(probeAfterStop.status, 0, 'Server should no longer accept connections after stop');

    console.log(`✓ Server stopped cleanly. PID ${pidToVerify} terminated. Zero orphaned processes.`);
    console.log('\n======================================================');
    console.log('✅ ALL VERIFICATION CHECKS PASSED SUCCESSFULLY (Exit 0)');
    console.log('======================================================\n');

  } catch (error) {
    console.error('\n❌ VERIFICATION FAILED:', error);
    if (serverStarted) {
      try {
        await harness.stop();
      } catch (_) {}
    }
    process.exit(1);
  }
}

// Execute when run directly
if (require.main === module) {
  runVerification().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { runVerification };
