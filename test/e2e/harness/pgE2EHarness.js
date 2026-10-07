// test/e2e/harness/pgE2EHarness.js
// PostgreSQL 17 WIN874 lifecycle manager for opaque-box E2E testing.

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

class PgE2EHarness {
  constructor(options = {}) {
    this.binDir = options.binDir || PgE2EHarness.findPgBinDir();
    this.port = options.port || (process.env.E2E_SHARED_PORT ? parseInt(process.env.E2E_SHARED_PORT, 10) : 54332);
    this.dataDir = path.resolve(options.dataDir || process.env.E2E_DATA_DIR || path.join(__dirname, '../../../.pgdata_e2e'));
    this.logFile = path.resolve(options.logFile || process.env.E2E_LOG_FILE || path.join(__dirname, '../../../pg_e2e.log'));
    this.database = options.database || 'ducklake_e2e';
    this.user = options.user || 'postgres';
    this.started = false;
  }

  static findPgBinDir() {
    const candidates = [
      'C:\\Users\\theze\\Downloads\\spiderman\\postgresql-17.11-3-windows-x64-binaries\\pgsql\\bin',
      process.env.PG_BIN_DIR || ''
    ];

    for (const dir of candidates) {
      if (dir && fs.existsSync(path.join(dir, 'pg_ctl.exe')) && fs.existsSync(path.join(dir, 'initdb.exe'))) {
        return dir;
      }
    }

    // Try finding via PATH
    try {
      const whereRes = execFileSync('where', ['pg_ctl.exe'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const firstLine = whereRes.trim().split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) {
        return path.dirname(firstLine);
      }
    } catch (_) {}

    throw new Error('PostgreSQL 17 binaries not found. Ensure pgsql/bin directory exists.');
  }

  binPath(binName) {
    const exe = binName.endsWith('.exe') ? binName : `${binName}.exe`;
    return path.join(this.binDir, exe);
  }

  static async isPortAvailable(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, host);
    });
  }

  static async findAvailablePort(startPort = 54332, maxTries = 50) {
    for (let p = startPort; p < startPort + maxTries; p++) {
      if (await PgE2EHarness.isPortAvailable(p)) {
        return p;
      }
    }
    throw new Error(`Unable to find an available port starting from ${startPort}`);
  }

  getPostmasterPid() {
    const pidFile = path.join(this.dataDir, 'postmaster.pid');
    if (!fs.existsSync(pidFile)) return null;
    try {
      const content = fs.readFileSync(pidFile, 'utf8');
      const lines = content.trim().split(/\r?\n/);
      const pid = parseInt(lines[0], 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (_) {
      return null;
    }
  }

  static isProcessAlive(pid) {
    if (!pid) return false;
    try {
      const res = spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8' });
      return res.stdout.includes(String(pid));
    } catch (_) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  forceKillPid(pid) {
    if (!pid) return;
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    } catch (_) {}
  }

  initCluster(forceClean = false) {
    if (fs.existsSync(this.dataDir)) {
      if (forceClean || !fs.existsSync(path.join(this.dataDir, 'PG_VERSION'))) {
        this.cleanDataDir();
      } else {
        // Cluster already initialized
        return;
      }
    }

    fs.mkdirSync(this.dataDir, { recursive: true });

    // Try initializing with WIN874 and Thai_Thailand.874 locale
    const initdbExe = this.binPath('initdb');
    let initRes = spawnSync(
      initdbExe,
      [
        '-D', this.dataDir,
        '-E', 'WIN874',
        '--locale=Thai_Thailand.874',
        '-U', this.user,
        '-A', 'trust',
        '--no-instructions'
      ],
      { encoding: 'utf8' }
    );

    if (initRes.status !== 0) {
      // Fallback: try with --no-locale if Thai_Thailand.874 fails
      initRes = spawnSync(
        initdbExe,
        [
          '-D', this.dataDir,
          '-E', 'WIN874',
          '--no-locale',
          '-U', this.user,
          '-A', 'trust',
          '--no-instructions'
        ],
        { encoding: 'utf8' }
      );
    }

    if (initRes.status !== 0) {
      throw new Error(`initdb failed with exit code ${initRes.status}: ${initRes.stderr || initRes.stdout}`);
    }
  }

  async startServer(timeoutMs = 20000) {
    // If port is in use, verify if it's our own cluster or pick a new port
    const available = await PgE2EHarness.isPortAvailable(this.port);
    if (!available) {
      // Check if it's already accepting connections on this port
      const readyRes = spawnSync(
        this.binPath('pg_isready'),
        ['-h', '127.0.0.1', '-p', String(this.port), '-U', this.user],
        { encoding: 'utf8' }
      );
      if (readyRes.status === 0) {
        this.started = true;
        return;
      }
      // Re-assign available port
      this.port = await PgE2EHarness.findAvailablePort(this.port + 1);
    }

    // Ensure log directory exists
    const logDir = path.dirname(this.logFile);
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

    // Critical: stdio must be 'ignore' on Windows to avoid deadlock
    const pgCtlExe = this.binPath('pg_ctl');
    const startRes = spawnSync(
      pgCtlExe,
      [
        '-D', this.dataDir,
        '-l', this.logFile,
        '-o', `-p ${this.port} -h 127.0.0.1 -c listen_addresses=127.0.0.1`,
        'start'
      ],
      { stdio: 'ignore' }
    );

    if (startRes.error) {
      throw startRes.error;
    }

    // Poll with pg_isready until connection accepted
    const start = Date.now();
    const pgIsReadyExe = this.binPath('pg_isready');
    while (Date.now() - start < timeoutMs) {
      const check = spawnSync(
        pgIsReadyExe,
        ['-h', '127.0.0.1', '-p', String(this.port), '-U', this.user],
        { stdio: 'ignore' }
      );
      if (check.status === 0) {
        this.started = true;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    throw new Error(`PostgreSQL failed to accept connections on port ${this.port} within ${timeoutMs}ms`);
  }

  createDatabase(dbName = this.database) {
    const createdbExe = this.binPath('createdb');
    const res = spawnSync(
      createdbExe,
      ['-h', '127.0.0.1', '-p', String(this.port), '-U', this.user, dbName],
      { encoding: 'utf8' }
    );

    if (res.status !== 0 && !res.stderr?.includes('already exists')) {
      // If createdb errors, try creating via psql
      const psqlExe = this.binPath('psql');
      const sqlRes = spawnSync(
        psqlExe,
        [
          '-h', '127.0.0.1',
          '-p', String(this.port),
          '-U', this.user,
          '-d', 'postgres',
          '-c', `CREATE DATABASE ${dbName};`
        ],
        { encoding: 'utf8' }
      );
      if (sqlRes.status !== 0 && !sqlRes.stderr?.includes('already exists')) {
        throw new Error(`Failed to create database '${dbName}': ${sqlRes.stderr || sqlRes.stdout}`);
      }
    }
  }

  async stopServer(timeoutMs = 15000) {
    const pid = this.getPostmasterPid();
    const pgCtlExe = this.binPath('pg_ctl');

    if (fs.existsSync(this.dataDir)) {
      try {
        spawnSync(
          pgCtlExe,
          ['-D', this.dataDir, 'stop', '-m', 'fast'],
          { stdio: 'ignore' }
        );
      } catch (_) {}
    }

    // Wait until process exits
    if (pid) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (!PgE2EHarness.isProcessAlive(pid)) {
          this.started = false;
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      // If still alive, fallback force kill
      this.forceKillPid(pid);
      this.started = false;
    } else {
      this.started = false;
    }
  }

  cleanDataDir() {
    const pid = this.getPostmasterPid();
    if (pid && PgE2EHarness.isProcessAlive(pid)) {
      this.forceKillPid(pid);
    }

    if (fs.existsSync(this.dataDir)) {
      try {
        fs.rmSync(this.dataDir, { recursive: true, force: true });
      } catch (err) {
        // Windows might briefly hold file locks; retry once after 500ms
        spawnSync('powershell', ['-Command', `Start-Sleep -Milliseconds 500; Remove-Item -Recurse -Force "${this.dataDir}" -ErrorAction SilentlyContinue`], { stdio: 'ignore' });
      }
    }

    if (fs.existsSync(this.logFile)) {
      try {
        fs.unlinkSync(this.logFile);
      } catch (_) {}
    }
  }

  getConnectionConfig() {
    return {
      host: '127.0.0.1',
      port: this.port,
      database: this.database,
      user: this.user,
      password: '',
      ssl: false,
      clientEncoding: 'auto'
    };
  }

  getPostgresUrl() {
    return `postgresql://${this.user}@127.0.0.1:${this.port}/${this.database}`;
  }

  getDuckDbAttachString(alias = 'lake', dataPath = '') {
    const pathClause = dataPath ? ` (DATA_PATH '${dataPath.replace(/\\/g, '/')}')` : '';
    return `ATTACH 'ducklake:postgres:host=127.0.0.1 port=${this.port} dbname=${this.database} user=${this.user}' AS ${alias}${pathClause};`;
  }
}

module.exports = { PgE2EHarness };
