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
/**
 * Robust test harness managing PostgreSQL 17 lifecycle, WIN874 Thai localization,
 * DuckLake metastore seeding, and clean teardown with zero orphaned processes.
 */
export declare class PgHarness implements IPgHarness {
    readonly binDir: string;
    readonly dataDir: string;
    readonly port: number;
    readonly host: string;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly logFile: string;
    readonly startupTimeoutMs: number;
    readonly autoCleanDataDir: boolean;
    private pid;
    private isRunning;
    private exitHandlerRegistered;
    constructor(config?: HarnessConfig);
    /**
     * Detects PostgreSQL binary directory from configuration, environment variables, or standard locations.
     */
    detectBinDir(explicitBinDir?: string): string;
    /**
     * Initializes PostgreSQL cluster with WIN874 encoding and Thai locale.
     */
    initdb(): void;
    /**
     * Starts PostgreSQL using pg_ctl with { stdio: 'ignore' } to avoid Windows handle deadlock,
     * then polls pg_isready until the server is ready.
     */
    start(): Promise<void>;
    /**
     * Polls pg_isready until PostgreSQL accepts connections or timeout expires.
     */
    waitForReady(): Promise<void>;
    /**
     * Reads PID from postmaster.pid in data directory.
     */
    readPostmasterPid(): number | null;
    /**
     * Seeds all fixtures: DuckLake metastore schema & active rows, native Thai tables with comments,
     * and corrupt comment fault table.
     */
    seedFixtures(): Promise<void>;
    /**
     * Stops PostgreSQL server cleanly using pg_ctl stop -m fast,
     * with fail-safe taskkill PID verification to ensure 0 orphaned processes.
     */
    stop(): Promise<void>;
    /**
     * Checks whether a process with given PID is currently alive on Windows.
     */
    isProcessAlive(pid: number): boolean;
    /**
     * Removes data directory with retries for Windows file locking delays.
     */
    cleanupDataDir(): void;
    /**
     * Returns connection configuration matching PostgresCatalogClient requirements.
     */
    getConnectionConfig(): ConnectionConfig;
    /**
     * Generates DuckDB ATTACH statement for DuckLake metastore.
     */
    getDuckDbAttachString(alias: string, dataPath: string): string;
    /**
     * Returns whether the server is currently marked running.
     */
    getStatus(): {
        isRunning: boolean;
        pid: number | null;
        port: number;
        dataDir: string;
    };
    /**
     * Registers Node process exit hooks to ensure zero orphaned processes on unexpected exits.
     */
    private registerProcessHandlers;
}
