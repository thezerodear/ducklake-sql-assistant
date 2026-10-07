// test/e2e/runE2E.js
// Master E2E Test Runner for ducklake-sql-assistant using Node.js native node:test

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const { PgE2EHarness } = require('./harness/pgE2EHarness');
const { FixtureSeeder } = require('./harness/fixtureSeeder');

async function main() {
  const startTime = Date.now();

  console.log('='.repeat(68));
  console.log('  DuckLake SQL Assistant — 4-Tier Opaque-Box E2E Test Suite');
  console.log('  Engine: PostgreSQL 17.11 (WIN874) | DuckDB 1.5.5 | Node.js ' + process.version);
  console.log('='.repeat(68));
  console.log('');

  // 1. Provision Isolated PostgreSQL 17 WIN874 Cluster
  const testPort = await PgE2EHarness.findAvailablePort(54332);
  const clusterDir = path.join(os.tmpdir(), `ducklake_e2e_cluster_${Date.now()}`);
  const logFile = path.join(os.tmpdir(), `ducklake_e2e_cluster_${Date.now()}.log`);

  console.log(`[1/5] Initializing WIN874 PostgreSQL 17 cluster on port ${testPort}...`);
  const harness = new PgE2EHarness({
    port: testPort,
    dataDir: clusterDir,
    logFile: logFile,
    database: 'ducklake_e2e',
    user: 'postgres'
  });

  // Ensure teardown on any exit or abort
  let tornDown = false;
  const cleanup = async () => {
    if (tornDown) return;
    tornDown = true;
    console.log('\n[Teardown] Stopping PostgreSQL daemon and cleaning up...');
    try {
      await harness.stopServer();
      harness.cleanDataDir();
    } catch (e) {
      console.error('Teardown error:', e.message);
    }
  };

  process.on('SIGINT', async () => { await cleanup(); process.exit(1); });
  process.on('SIGTERM', async () => { await cleanup(); process.exit(1); });
  process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception in runner:', err);
    await cleanup();
    process.exit(1);
  });

  try {
    harness.initCluster();
    await harness.startServer();
    console.log(`[2/5] Server running (PID: ${harness.getPostmasterPid()}). Seeding test fixtures...`);

    harness.createDatabase('ducklake_e2e');
    const seeder = new FixtureSeeder(harness.getConnectionConfig());
    await seeder.seedAll(harness);
    console.log('[3/5] Fixtures seeded successfully across ducklake_e2e and ducklake_corrupt_db.');

    // 2. Define Test Tiers
    const tiers = [
      {
        name: 'Tier 1: Feature Isolation Coverage (F1 to F14)',
        file: path.resolve(__dirname, 'tier1_features.test.js')
      },
      {
        name: 'Tier 2: Boundary & Corner Cases (F1 to F14)',
        file: path.resolve(__dirname, 'tier2_boundary.test.js')
      },
      {
        name: 'Tier 3: Cross-Feature Combinations & Pairwise Interactions',
        file: path.resolve(__dirname, 'tier3_combinations.test.js')
      },
      {
        name: 'Tier 4: Real-World Workload Scenarios',
        file: path.resolve(__dirname, 'tier4_real_world.test.js')
      }
    ];

    console.log('\n[4/5] Executing 4-Tier Test Suites...\n');

    const results = [];
    let allPassed = true;

    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      console.log(`>>> Running [${i + 1}/${tiers.length}] ${tier.name}...`);
      const t0 = Date.now();

      const runEnv = {
        ...process.env,
        E2E_SHARED_PORT: String(testPort),
        E2E_DATA_DIR: clusterDir,
        E2E_LOG_FILE: logFile
      };

      const res = spawnSync(
        process.execPath,
        ['--test', tier.file],
        {
          stdio: 'inherit',
          env: runEnv,
          encoding: 'utf8'
        }
      );

      const elapsed = Date.now() - t0;
      const passed = res.status === 0;
      if (!passed) allPassed = false;

      results.push({
        tier: tier.name,
        passed,
        exitCode: res.status,
        durationMs: elapsed
      });

      console.log(`>>> ${tier.name}: ${passed ? 'PASSED' : 'FAILED'} (${(elapsed / 1000).toFixed(2)}s)\n`);
    }

    // 3. Print Final Report
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('='.repeat(68));
    console.log('                      E2E TEST RUN SUMMARY');
    console.log('='.repeat(68));
    for (const r of results) {
      const statusIcon = r.passed ? '✔ PASS' : '✖ FAIL';
      const timeStr = `${(r.durationMs / 1000).toFixed(2)}s`;
      console.log(` ${statusIcon}  ${r.tier.padEnd(52)} ${timeStr.padStart(8)}`);
    }
    console.log('-'.repeat(68));
    console.log(` Overall Result: ${allPassed ? 'ALL TIERS PASSED (100%)' : 'SOME TIERS FAILED'}`);
    console.log(` Total Duration: ${totalElapsed}s`);
    console.log('='.repeat(68));

    // 4. Teardown
    console.log('\n[5/5] Performing clean process lifecycle teardown...');
    await cleanup();
    console.log('[Teardown Complete] Zero orphan background processes remaining.');

    process.exit(allPassed ? 0 : 1);
  } catch (err) {
    console.error('Fatal error during E2E test execution:', err);
    await cleanup();
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
