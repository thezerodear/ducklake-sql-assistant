import { spawnSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from 'pg';
import { seedAllFixtures } from '../fixtures/fixtures';

export interface HarnessConfig {
  /** Directory containing PostgreSQL 17 binaries (initdb, pg_ctl, pg_isready) */
  binDir?: string;
  /** Directory where PostgreSQL cluster data files reside */
  dataDir?: string;
  /** Port PostgreSQL listens on (defaults to 5439) */
  port?: number;
  /** Host to bind (defaults to 127.0.0.1) */
  host?: string;
  /** Database name (defaults to postgres) */
  database?: string;
  /** Superuser name (defaults to postgres) */
  user?: string;
  /** Superuser password (defaults to empty string for trust auth) */
  password?: string;
  /** Server log file path (defaults to <dataDir>/server.log) */
  logFile?: string;
  /** Milliseconds to wait for pg_isready before timing out */
  startupTimeoutMs?: number;
  /** Whether to wipe dataDir on cleanup (defaults to false) */
  autoCleanDataDir?: boolean;
}

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  clientEncoding?: string;
  connectionName?: string;
  catalogType?: string;
}

export interface IPgHarness {
  start(): Promise<void>;
  stop(): Promise<void>;
  seedFixtures(): Promise<void>;
  getConnectionConfig(): ConnectionConfig;
  getDuckDbAttachString(alias: string, dataPath: string): string;
}

const DEFAULT_BIN_CANDIDATES = [
  'C:\\Users\\theze\\Downloads\\spiderman\\postgresql-17.11-3-windows-x64-binaries\\pgsql\\bin',
  'C:\\Program Files\\PostgreSQL\\17\\bin',
];

/**
 * Robust test harness managing PostgreSQL 17 lifecycle, WIN874 Thai localization,
 * DuckLake metastore seeding, and clean teardown with zero orphaned processes.
 */
export class PgHarness implements IPgHarness {
  public readonly binDir: string;
  public readonly dataDir: string;
  public readonly port: number;
  public readonly host: string;
  public readonly database: string;
  public readonly user: string;
  public readonly password: string;
  public readonly logFile: string;
  public readonly startupTimeoutMs: number;
  public readonly autoCleanDataDir: boolean;

  private pid: number | null = null;
  private isRunning: boolean = false;
  private exitHandlerRegistered: boolean = false;

  constructor(config: HarnessConfig = {}) {
    this.binDir = this.detectBinDir(config.binDir);
    this.port = config.port || parseInt(process.env.PGPORT || '5439', 10);
    this.host = config.host || '127.0.0.1';
    this.database = config.database || 'postgres';
    this.user = config.user || 'postgres';
    this.password = config.password || '';
    this.dataDir = config.dataDir || path.resolve(process.cwd(), 'test', '.pgdata');
    this.logFile = config.logFile || path.resolve(this.dataDir, 'server.log');
    this.startupTimeoutMs = config.startupTimeoutMs || 20000;
    this.autoCleanDataDir = config.autoCleanDataDir ?? false;

    this.registerProcessHandlers();
  }

  /**
   * Detects PostgreSQL binary directory from configuration, environment variables, or standard locations.
   */
  public detectBinDir(explicitBinDir?: string): string {
    const candidates: string[] = [];

    if (explicitBinDir) candidates.push(explicitBinDir);
    if (process.env.PG_BIN_DIR) candidates.push(process.env.PG_BIN_DIR);
    if (process.env.PGBIN) candidates.push(process.env.PGBIN);
    candidates.push(...DEFAULT_BIN_CANDIDATES);

    for (const dir of candidates) {
      if (
        fs.existsSync(dir) &&
        fs.existsSync(path.join(dir, 'initdb.exe')) &&
        fs.existsSync(path.join(dir, 'pg_ctl.exe')) &&
        fs.existsSync(path.join(dir, 'pg_isready.exe'))
      ) {
        return path.resolve(dir);
      }
    }

    throw new Error(
      `PostgreSQL 17 binaries not found. Checked locations:\n${candidates.map((c) => `  - ${c}`).join('\n')}\n` +
      `Ensure PostgreSQL 17 is available or set PG_BIN_DIR environment variable.`
    );
  }

  /**
   * Initializes PostgreSQL cluster with WIN874 encoding and Thai locale.
   */
  public initdb(): void {
    const initdbExe = path.join(this.binDir, 'initdb.exe');
    if (!fs.existsSync(initdbExe)) {
      throw new Error(`initdb.exe not found at ${initdbExe}`);
    }

    // If data directory already has files, remove them first
    if (fs.existsSync(this.dataDir)) {
      this.cleanupDataDir();
    }
    fs.mkdirSync(this.dataDir, { recursive: true });

    const args = [
      '-D', this.dataDir,
      '-E', 'WIN874',
      '--locale=Thai_Thailand.874',
      '-U', this.user,
      '-A', 'trust',
      '--no-instructions',
    ];

    const result = spawnSync(initdbExe, args, {
      encoding: 'utf-8',
      windowsHide: true,
    });

    if (result.status !== 0) {
      const errMsg = result.stderr || result.stdout || `exit code ${result.status}`;
      throw new Error(`initdb failed: ${errMsg}`);
    }
  }

  /**
   * Starts PostgreSQL using pg_ctl with { stdio: 'ignore' } to avoid Windows handle deadlock,
   * then polls pg_isready until the server is ready.
   */
  public async start(): Promise<void> {
    const pgCtlExe = path.join(this.binDir, 'pg_ctl.exe');
    if (!fs.existsSync(pgCtlExe)) {
      throw new Error(`pg_ctl.exe not found at ${pgCtlExe}`);
    }

    // Ensure cluster is initialized
    const pgVersionFile = path.join(this.dataDir, 'PG_VERSION');
    if (!fs.existsSync(pgVersionFile)) {
      this.initdb();
    }

    // Ensure log directory exists
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    // CRITICAL: On Windows, spawnSync/spawn with pipe stdio deadlocks on pg_ctl start
    // because background postgres.exe daemon inherits standard I/O handles.
    // MUST use stdio: 'ignore'
    const startArgs = [
      '-D', this.dataDir,
      '-l', this.logFile,
      '-o', `-p ${this.port} -h ${this.host}`,
      'start',
    ];

    const startRes = spawnSync(pgCtlExe, startArgs, {
      stdio: 'ignore',
      windowsHide: true,
    });

    if (startRes.status !== 0) {
      throw new Error(`pg_ctl start returned non-zero exit code: ${startRes.status}`);
    }

    // Wait for server to become ready via pg_isready
    await this.waitForReady();

    // Cache PID from postmaster.pid
    this.readPostmasterPid();
    this.isRunning = true;
  }

  /**
   * Polls pg_isready until PostgreSQL accepts connections or timeout expires.
   */
  public async waitForReady(): Promise<void> {
    const pgIsReadyExe = path.join(this.binDir, 'pg_isready.exe');
    const startTime = Date.now();
    const intervalMs = 150;

    while (Date.now() - startTime < this.startupTimeoutMs) {
      const probe = spawnSync(pgIsReadyExe, [
        '-h', this.host,
        '-p', String(this.port),
        '-U', this.user,
      ], {
        stdio: 'ignore',
        windowsHide: true,
      });

      if (probe.status === 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    // Log diagnostic if timeout exceeded
    let logSnippet = '';
    if (fs.existsSync(this.logFile)) {
      try {
        logSnippet = fs.readFileSync(this.logFile, 'utf-8').slice(-1000);
      } catch (_) {}
    }

    await this.stop();
    throw new Error(
      `PostgreSQL server failed to become ready on ${this.host}:${this.port} within ${this.startupTimeoutMs}ms.` +
      (logSnippet ? `\nServer log tail:\n${logSnippet}` : '')
    );
  }

  /**
   * Reads PID from postmaster.pid in data directory.
   */
  public readPostmasterPid(): number | null {
    const pidFile = path.join(this.dataDir, 'postmaster.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const content = fs.readFileSync(pidFile, 'utf-8');
        const firstLine = content.split('\n')[0].trim();
        const parsed = parseInt(firstLine, 10);
        if (!isNaN(parsed) && parsed > 0) {
          this.pid = parsed;
          return parsed;
        }
      } catch (_) {}
    }
    return null;
  }

  /**
   * Seeds all fixtures: DuckLake metastore schema & active rows, native Thai tables with comments,
   * and corrupt comment fault table.
   */
  public async seedFixtures(): Promise<void> {
    const client = new Client({
      host: this.host,
      port: this.port,
      user: this.user,
      database: this.database,
      password: this.password,
    });

    await client.connect();
    try {
      await seedAllFixtures(client);
    } finally {
      await client.end();
    }
  }

  /**
   * Stops PostgreSQL server cleanly using pg_ctl stop -m fast,
   * with fail-safe taskkill PID verification to ensure 0 orphaned processes.
   */
  public async stop(): Promise<void> {
    const pgCtlExe = path.join(this.binDir, 'pg_ctl.exe');
    this.readPostmasterPid();
    const pidToKill = this.pid;

    // 1. Attempt graceful fast shutdown via pg_ctl
    if (fs.existsSync(this.dataDir) && fs.existsSync(pgCtlExe)) {
      spawnSync(pgCtlExe, [
        '-D', this.dataDir,
        'stop',
        '-m', 'fast',
      ], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }

    // 2. Poll up to 4 seconds to confirm postmaster process exited
    if (pidToKill) {
      let isAlive = this.isProcessAlive(pidToKill);
      const pollStart = Date.now();
      while (isAlive && Date.now() - pollStart < 4000) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        isAlive = this.isProcessAlive(pidToKill);
      }

      // 3. Fail-safe fallback: taskkill /PID <pid> /T /F if still running
      if (isAlive) {
        try {
          spawnSync('taskkill', ['/PID', String(pidToKill), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (_) {}
      }
    }

    this.pid = null;
    this.isRunning = false;

    if (this.autoCleanDataDir) {
      this.cleanupDataDir();
    }
  }

  /**
   * Checks whether a process with given PID is currently alive on Windows.
   */
  public isProcessAlive(pid: number): boolean {
    if (!pid || isNaN(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err.code === 'EPERM';
    }
  }

  /**
   * Removes data directory with retries for Windows file locking delays.
   */
  public cleanupDataDir(): void {
    if (!fs.existsSync(this.dataDir)) return;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 3 });
        return;
      } catch (err) {
        spawnSync('powershell', ['-Command', 'Start-Sleep -Milliseconds 100'], { stdio: 'ignore' });
      }
    }
  }

  /**
   * Returns connection configuration matching PostgresCatalogClient requirements.
   */
  public getConnectionConfig(): ConnectionConfig {
    return {
      host: this.host,
      port: this.port,
      database: this.database,
      user: this.user,
      password: this.password,
      clientEncoding: 'auto',
      connectionName: 'Test PG17 WIN874',
      catalogType: 'server',
    };
  }

  /**
   * Generates DuckDB ATTACH statement for DuckLake metastore.
   */
  public getDuckDbAttachString(alias: string, dataPath: string): string {
    const normalizedDataPath = dataPath.replace(/\\/g, '/');
    return `ATTACH 'ducklake:postgres:host=${this.host} port=${this.port} dbname=${this.database} user=${this.user}' AS ${alias} (DATA_PATH '${normalizedDataPath}');`;
  }

  /**
   * Returns whether the server is currently marked running.
   */
  public getStatus(): { isRunning: boolean; pid: number | null; port: number; dataDir: string } {
    return {
      isRunning: this.isRunning,
      pid: this.pid,
      port: this.port,
      dataDir: this.dataDir,
    };
  }

  /**
   * Registers Node process exit hooks to ensure zero orphaned processes on unexpected exits.
   */
  private registerProcessHandlers(): void {
    if (this.exitHandlerRegistered) return;
    this.exitHandlerRegistered = true;

    const cleanupSync = () => {
      if (this.pid) {
        try {
          spawnSync('taskkill', ['/PID', String(this.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch (_) {}
      }
    };

    process.on('exit', cleanupSync);
    process.on('SIGINT', () => {
      cleanupSync();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      cleanupSync();
      process.exit(143);
    });
  }
}
