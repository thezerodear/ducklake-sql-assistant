import * as assert from 'assert';
import { spawnSync, execSync } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs';
import { PgHarness } from './pgHarness';
import { Client } from 'pg';

export interface ProcessNode {
  ProcessId: number;
  ParentProcessId: number;
  CommandLine: string;
}

/**
 * Queries all processes in Windows matching given postmaster PID or parent PID.
 */
function getProcessTree(postmasterPid: number | null): ProcessNode[] {
  if (!postmasterPid) return [];
  try {
    const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${postmasterPid} -or $_.ParentProcessId -eq ${postmasterPid} } | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json`;
    const out = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    return [];
  }
}

/**
 * Counts postgres.exe processes visible in Windows tasklist.
 */
function getTasklistPostgresCount(): number {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq postgres.exe" /FO CSV /NH', {
      encoding: 'utf-8',
      windowsHide: true,
    }).trim();
    if (!out || out.includes('No tasks are running')) return 0;
    return out.split('\r\n').filter((l) => l.toLowerCase().includes('postgres.exe')).length;
  } catch (err) {
    return 0;
  }
}

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StressSummary {
  rapidCyclesPassed: boolean;
  rapidCycleDetails: Array<{
    cycle: number;
    postmasterPid: number;
    childrenCount: number;
    startMs: number;
    stopMs: number;
    lingeringInTree: number;
  }>;
  portConflictTcpPassed: boolean;
  portConflictDuplicatePassed: boolean;
  crashRecoveryPassed: boolean;
  globalLingeringCount: number;
  overallApproved: boolean;
}

export async function runStressSuite(): Promise<StressSummary> {
  console.log('================================================================');
  console.log('    EMPIRICAL STRESS TEST HARNESS — PGHARNESS ON WINDOWS       ');
  console.log('================================================================\n');

  const baselineCount = getTasklistPostgresCount();
  console.log(`[Baseline] Global postgres.exe processes before suite: ${baselineCount}`);

  const summary: StressSummary = {
    rapidCyclesPassed: false,
    rapidCycleDetails: [],
    portConflictTcpPassed: false,
    portConflictDuplicatePassed: false,
    crashRecoveryPassed: false,
    globalLingeringCount: 0,
    overallApproved: false,
  };

  // --------------------------------------------------------------------------
  // TEST 1: RAPID START AND STOP CYCLES (5 consecutive cycles on port 5460)
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST 1] RAPID START AND STOP CYCLES (5 consecutive cycles) ---');
  const rapidPort = 5460;
  const rapidDataDir = path.resolve(process.cwd(), 'test', '.pgdata_rapid_stress');

  const rapidHarness = new PgHarness({
    port: rapidPort,
    dataDir: rapidDataDir,
    autoCleanDataDir: false,
    startupTimeoutMs: 15000,
  });

  let rapidAllPassed = true;
  for (let cycle = 1; cycle <= 5; cycle++) {
    process.stdout.write(`Cycle ${cycle}/5: starting... `);
    const t0 = Date.now();
    await rapidHarness.start();
    const startMs = Date.now() - t0;
    const postmasterPid = rapidHarness.getStatus().pid!;

    // Capture child processes while running
    const treeWhileRunning = getProcessTree(postmasterPid);
    const childrenCount = treeWhileRunning.filter((p) => p.ProcessId !== postmasterPid).length;
    const allPidsInCycle = treeWhileRunning.map((p) => p.ProcessId);

    process.stdout.write(`ready (${startMs}ms, PID ${postmasterPid}, children: ${childrenCount}) -> stopping... `);

    const tStop = Date.now();
    await rapidHarness.stop();
    const stopMs = Date.now() - tStop;
    process.stdout.write(`stopped (${stopMs}ms) -> `);

    // Verify all processes in this cycle's tree are dead
    let lingeringInTree = 0;
    for (const p of allPidsInCycle) {
      if (isPidAlive(p)) {
        lingeringInTree++;
      }
    }

    const postStopTree = getProcessTree(postmasterPid);
    lingeringInTree = Math.max(lingeringInTree, postStopTree.length);

    console.log(`lingering tree processes: ${lingeringInTree}`);

    summary.rapidCycleDetails.push({
      cycle,
      postmasterPid,
      childrenCount,
      startMs,
      stopMs,
      lingeringInTree,
    });

    if (lingeringInTree !== 0) {
      console.error(`❌ Cycle ${cycle} failed: ${lingeringInTree} processes still alive!`);
      rapidAllPassed = false;
    }
  }

  rapidHarness.cleanupDataDir();
  summary.rapidCyclesPassed = rapidAllPassed;
  console.log(`[TEST 1 Verdict] Rapid 5-Cycle Start/Stop: ${rapidAllPassed ? 'PASSED ✅' : 'FAILED ❌'}`);

  // --------------------------------------------------------------------------
  // TEST 2A: PORT CONFLICT BEHAVIOR — OCCUPIED BY EXTERNAL TCP SERVER
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST 2A] PORT CONFLICT — OCCUPIED BY EXTERNAL TCP SERVER ---');
  const tcpPort = 5461;
  const tcpDataDir = path.resolve(process.cwd(), 'test', '.pgdata_tcp_conflict');

  const dummyTcp = net.createServer((sock) => {
    sock.write('BUSY');
    sock.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    dummyTcp.listen(tcpPort, '127.0.0.1', () => {
      console.log(`✓ Dummy TCP listener active on 127.0.0.1:${tcpPort}`);
      resolve();
    });
    dummyTcp.on('error', reject);
  });

  const tcpConflictHarness = new PgHarness({
    port: tcpPort,
    dataDir: tcpDataDir,
    startupTimeoutMs: 3000,
    autoCleanDataDir: true,
  });

  let tcpConflictThrew = false;
  let tcpConflictErrorMsg = '';
  try {
    console.log(`Attempting PgHarness.start() on port ${tcpPort}...`);
    await tcpConflictHarness.start();
  } catch (err: any) {
    tcpConflictThrew = true;
    tcpConflictErrorMsg = err.message;
    console.log(`✓ PgHarness rejected occupied port with error: ${err.message.split('\n')[0]}`);
  } finally {
    await new Promise<void>((resolve) => dummyTcp.close(() => resolve()));
    try { await tcpConflictHarness.stop(); } catch (_) {}
  }

  // Verify no lingering process from tcpConflictHarness
  const tcpPostmasterPid = tcpConflictHarness.getStatus().pid;
  const tcpLingering = tcpPostmasterPid ? getProcessTree(tcpPostmasterPid).length : 0;
  console.log(`Lingering processes from failed TCP conflict harness: ${tcpLingering}`);

  summary.portConflictTcpPassed = tcpConflictThrew && tcpLingering === 0;
  console.log(`[TEST 2A Verdict] Mock TCP Port Conflict: ${summary.portConflictTcpPassed ? 'PASSED ✅' : 'FAILED ❌'}`);

  // --------------------------------------------------------------------------
  // TEST 2B: PORT CONFLICT BEHAVIOR — DUPLICATE POSTGRES ON SAME PORT
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST 2B] PORT CONFLICT — DUPLICATE POSTGRESQL INSTANCE ---');
  const dupPort = 5462;
  const h1DataDir = path.resolve(process.cwd(), 'test', '.pgdata_dup_h1');
  const h2DataDir = path.resolve(process.cwd(), 'test', '.pgdata_dup_h2');

  const harness1 = new PgHarness({
    port: dupPort,
    dataDir: h1DataDir,
    startupTimeoutMs: 10000,
    autoCleanDataDir: true,
  });

  const harness2 = new PgHarness({
    port: dupPort,
    dataDir: h2DataDir,
    startupTimeoutMs: 3000,
    autoCleanDataDir: true,
  });

  let dupPassed = false;
  try {
    console.log(`Starting Primary PgHarness 1 on port ${dupPort}...`);
    await harness1.start();
    const pid1 = harness1.getStatus().pid!;
    console.log(`✓ Primary PgHarness 1 active with PID ${pid1}`);

    // Verify Primary is receptive
    const client = new Client(harness1.getConnectionConfig());
    await client.connect();
    const qRes = await client.query('SELECT 1 as num;');
    assert.strictEqual(qRes.rows[0].num, 1);
    await client.end();
    console.log(`✓ Primary PgHarness 1 responds to SQL queries.`);

    console.log(`Attempting to start Secondary PgHarness 2 on SAME port ${dupPort}...`);
    let h2Failed = false;
    try {
      await harness2.start();
      console.warn(`Harness 2 returned without throwing.`);
    } catch (err: any) {
      h2Failed = true;
      console.log(`✓ Secondary PgHarness 2 failed as expected: ${err.message.split('\n')[0]}`);
    }

    // Clean up Harness 2
    await harness2.stop();

    // Verify Primary Harness 1 was NOT disrupted by Harness 2's failed attempt
    const isPrimaryAlive = isPidAlive(pid1);
    console.log(`Primary PgHarness 1 still healthy after conflict: ${isPrimaryAlive}`);
    assert.strictEqual(isPrimaryAlive, true, 'Primary harness must survive conflict attempt');

    // Stop Primary Harness 1
    await harness1.stop();
    const tree1After = getProcessTree(pid1);
    console.log(`Primary tree lingering processes after stop: ${tree1After.length}`);

    dupPassed = h2Failed && isPrimaryAlive && tree1After.length === 0;
  } catch (err: any) {
    console.error(`❌ Duplicate test error: ${err.message}`);
    try { await harness1.stop(); } catch (_) {}
    try { await harness2.stop(); } catch (_) {}
  }

  summary.portConflictDuplicatePassed = dupPassed;
  console.log(`[TEST 2B Verdict] Duplicate Postgres Port Conflict: ${dupPassed ? 'PASSED ✅' : 'FAILED ❌'}`);

  // --------------------------------------------------------------------------
  // TEST 3: PROCESS CLEANUP & CRASH / HARD TASKKILL ROBUSTNESS
  // --------------------------------------------------------------------------
  console.log('\n--- [TEST 3] FAIL-SAFE TEARDOWN AFTER EXTERNAL POSTMASTER KILL ---');
  const crashPort = 5463;
  const crashDataDir = path.resolve(process.cwd(), 'test', '.pgdata_crash_rec');

  const crashHarness = new PgHarness({
    port: crashPort,
    dataDir: crashDataDir,
    startupTimeoutMs: 10000,
    autoCleanDataDir: true,
  });

  let crashPassed = false;
  try {
    console.log(`Starting PgHarness on port ${crashPort}...`);
    await crashHarness.start();
    const crashPid = crashHarness.getStatus().pid!;
    const tree = getProcessTree(crashPid);
    console.log(`✓ Running with PID ${crashPid}, tree size: ${tree.length}`);

    console.log(`Killing Postmaster PID ${crashPid} externally via taskkill /F...`);
    spawnSync('taskkill', ['/PID', String(crashPid), '/F'], { stdio: 'ignore', windowsHide: true });
    await sleep(200);

    console.log(`Calling crashHarness.stop() to verify clean teardown...`);
    const stopT0 = Date.now();
    await crashHarness.stop();
    console.log(`✓ crashHarness.stop() returned safely in ${Date.now() - stopT0}ms.`);

    const lingering = getProcessTree(crashPid);
    console.log(`Lingering tree processes: ${lingering.length}`);
    crashPassed = lingering.length === 0;
  } catch (err: any) {
    console.error(`❌ Crash recovery error: ${err.message}`);
    try { await crashHarness.stop(); } catch (_) {}
  }

  summary.crashRecoveryPassed = crashPassed;
  console.log(`[TEST 3 Verdict] Crash Recovery & Cleanup: ${crashPassed ? 'PASSED ✅' : 'FAILED ❌'}`);

  // --------------------------------------------------------------------------
  // FINAL VERDICT & METRICS
  // --------------------------------------------------------------------------
  await sleep(1000);
  const tasklistCount = getTasklistPostgresCount();
  summary.globalLingeringCount = tasklistCount;

  summary.overallApproved =
    summary.rapidCyclesPassed &&
    summary.portConflictTcpPassed &&
    summary.portConflictDuplicatePassed &&
    summary.crashRecoveryPassed;

  console.log('\n================================================================');
  console.log('                 EMPIRICAL STRESS TEST VERDICT                  ');
  console.log('================================================================');
  console.log(`1. Rapid 5-Cycle Start/Stop:      ${summary.rapidCyclesPassed ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log(`2. Port Conflict (TCP Listener):  ${summary.portConflictTcpPassed ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log(`3. Port Conflict (Duplicate Pg):  ${summary.portConflictDuplicatePassed ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log(`4. Hard Crash Recovery Teardown:  ${summary.crashRecoveryPassed ? 'PASSED ✅' : 'FAILED ❌'}`);
  console.log(`5. Global Lingering Processes:    ${summary.globalLingeringCount} in tasklist`);
  console.log('----------------------------------------------------------------');
  console.log(`OVERALL LIFECYCLE VERDICT:        ${summary.overallApproved ? 'APPROVE ✅' : 'REJECT ❌'}`);
  console.log('================================================================\n');

  return summary;
}

if (require.main === module) {
  runStressSuite()
    .then((res) => {
      process.exit(res.overallApproved ? 0 : 1);
    })
    .catch((err) => {
      console.error('Fatal stress suite failure:', err);
      process.exit(1);
    });
}
