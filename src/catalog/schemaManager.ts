import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PostgresCatalogClient } from './postgresClient';
import { DuckDBLocalClient } from './duckdbClient';
import { TableMetadata, ColumnMetadata, PostgresConfig, CatalogState, ConnectionState, DatabaseCatalog } from './types';
import { ConfigStorage } from './configStorage';

export class SchemaManager implements vscode.Disposable {
  private client: PostgresCatalogClient;
  private databaseCatalogs = new Map<string, DatabaseCatalog>();
  private state: CatalogState;
  private refreshTimer?: NodeJS.Timeout;
  private disposables: vscode.Disposable[] = [];
  private onDidChangeSchemaEmitter = new vscode.EventEmitter<CatalogState>();
  public readonly onDidChangeSchema = this.onDidChangeSchemaEmitter.event;

  constructor() {
    const config = this.readConfig();
    this.client = new PostgresCatalogClient(config);
    this.state = {
      status: 'disconnected',
      tables: new Map<string, TableMetadata>(),
      databases: this.databaseCatalogs,
      activeDatabase: ConfigStorage.getActiveConnectionName()
    };

    this.disposables.push(
      ConfigStorage.onDidChangeConfig((newConfig) => {
        this.client.updateConfig(newConfig);
        this.refreshCatalog(true).catch(() => {});
      })
    );

    // Load initial schema
    this.refreshCatalog(true).catch((err) => {
      console.error('DuckLake: Initial schema refresh error:', err);
    });
  }

  public readConfig(connectionName?: string): PostgresConfig {
    if (connectionName) {
      const found = ConfigStorage.getConnection(connectionName);
      if (found) return found;
    }
    return ConfigStorage.loadConfig();
  }

  public getState(): CatalogState {
    this.state.databases = this.databaseCatalogs;
    this.state.activeDatabase = this.getActiveDatabaseName();
    return this.state;
  }

  public getDatabases(): DatabaseCatalog[] {
    return Array.from(this.databaseCatalogs.values());
  }

  public getActiveDatabaseName(): string {
    return ConfigStorage.getActiveConnectionName();
  }

  public getActiveDatabase(): DatabaseCatalog | undefined {
    const activeName = this.getActiveDatabaseName().toLowerCase();
    for (const [key, db] of this.databaseCatalogs) {
      if (key.toLowerCase() === activeName || db.connectionName.toLowerCase() === activeName || db.databaseAlias.toLowerCase() === activeName) {
        return db;
      }
    }
    return this.databaseCatalogs.values().next().value;
  }

  public async setActiveDatabase(name: string): Promise<boolean> {
    const ok = await ConfigStorage.setActiveConnection(name);
    if (ok) {
      this.rebuildAggregateTables();
      this.state.activeDatabase = name;
      this.onDidChangeSchemaEmitter.fire(this.getState());
    }
    return ok;
  }

  public getTables(databaseNameOrAlias?: string): TableMetadata[] {
    if (databaseNameOrAlias) {
      const clean = databaseNameOrAlias.toLowerCase().trim();
      for (const [key, db] of this.databaseCatalogs) {
        if (key.toLowerCase() === clean || db.connectionName.toLowerCase() === clean || db.databaseAlias.toLowerCase() === clean) {
          return db.tables;
        }
      }
      return [];
    }

    const unique = new Set<TableMetadata>();
    for (const table of this.state.tables.values()) {
      unique.add(table);
    }
    return Array.from(unique);
  }

  public findTable(nameOrAlias: string, databaseNameOrAlias?: string): TableMetadata | undefined {
    let clean = nameOrAlias.toLowerCase().trim().replace(/["`]/g, '');

    // 1. If explicit database specified, search within that database
    if (databaseNameOrAlias) {
      const dbTables = this.getTables(databaseNameOrAlias);
      const match = dbTables.find(t =>
        t.fullName.toLowerCase() === clean ||
        t.name.toLowerCase() === clean ||
        (clean.includes('.') && clean.endsWith('.' + t.name.toLowerCase()))
      );
      if (match) return match;
    }

    // 2. Direct lookup in aggregate tables map
    if (this.state.tables.has(clean)) {
      return this.state.tables.get(clean);
    }

    // 3. Multi-part notation analysis: db.schema.table or schema.table
    if (clean.includes('.')) {
      const parts = clean.split('.');
      if (parts.length >= 3) {
        const [dbPart, schemaPart, tblPart] = parts;
        const dbTables = this.getTables(dbPart);
        const match = dbTables.find(t =>
          t.schema.toLowerCase() === schemaPart && t.name.toLowerCase() === tblPart
        );
        if (match) return match;
      }

      if (parts.length >= 2) {
        // Could be db.table or schema.table
        const [firstPart, secondPart] = parts.slice(-2);
        // Check if firstPart is a database
        const dbTables = this.getTables(firstPart);
        if (dbTables.length > 0) {
          const match = dbTables.find(t => t.name.toLowerCase() === secondPart || t.fullName.toLowerCase().endsWith('.' + secondPart));
          if (match) return match;
        }

        const twoPart = parts.slice(-2).join('.');
        if (this.state.tables.has(twoPart)) {
          return this.state.tables.get(twoPart);
        }
      }

      const simple = parts[parts.length - 1];
      if (this.state.tables.has(simple)) {
        return this.state.tables.get(simple);
      }
    }

    // 4. Check active database first
    const activeDb = this.getActiveDatabase();
    if (activeDb) {
      const found = activeDb.tables.find(t => t.name.toLowerCase() === clean || t.fullName.toLowerCase() === clean);
      if (found) return found;
    }

    return undefined;
  }

  public getAllColumns(databaseNameOrAlias?: string): { column: ColumnMetadata; table: TableMetadata }[] {
    const result: { column: ColumnMetadata; table: TableMetadata }[] = [];
    const tables = this.getTables(databaseNameOrAlias);
    for (const table of tables) {
      for (const column of table.columns) {
        result.push({ column, table });
      }
    }
    return result;
  }

  public getColumnsForTable(tableName: string, databaseNameOrAlias?: string): ColumnMetadata[] {
    const table = this.findTable(tableName, databaseNameOrAlias);
    return table ? table.columns : [];
  }

  public loadSampleSchema(): void {
    const samples = PostgresCatalogClient.getSampleCatalog();
    for (const t of samples) {
      t.databaseAlias = 'lake';
    }
    this.databaseCatalogs.set('lake', {
      connectionName: 'lake',
      databaseAlias: 'lake',
      status: 'disconnected',
      catalogType: 'server',
      tables: samples,
      lastRefreshed: new Date(),
      config: this.readConfig()
    });
    this.rebuildAggregateTables();
    this.state.status = 'disconnected';
    this.state.lastRefreshed = new Date();
    this.onDidChangeSchemaEmitter.fire(this.getState());
  }

  private rebuildAggregateTables(): void {
    this.state.tables.clear();
    const activeName = this.getActiveDatabaseName().toLowerCase();

    // 1. First add tables from active database for highest priority
    for (const [key, db] of this.databaseCatalogs) {
      const isActive = key.toLowerCase() === activeName || db.connectionName.toLowerCase() === activeName || db.databaseAlias.toLowerCase() === activeName;
      if (isActive) {
        for (const table of db.tables) {
          this.state.tables.set(table.fullName.toLowerCase(), table);
          if (!this.state.tables.has(table.name.toLowerCase())) {
            this.state.tables.set(table.name.toLowerCase(), table);
          }
        }
      }
    }

    // 2. Add database-qualified keys for all databases
    for (const [, db] of this.databaseCatalogs) {
      const alias = (db.databaseAlias || db.connectionName).toLowerCase();
      const conn = db.connectionName.toLowerCase();

      for (const table of db.tables) {
        // e.g. "lake.main.customers" & "lake.customers"
        this.state.tables.set(`${alias}.${table.fullName.toLowerCase()}`, table);
        this.state.tables.set(`${alias}.${table.name.toLowerCase()}`, table);
        if (conn !== alias) {
          this.state.tables.set(`${conn}.${table.fullName.toLowerCase()}`, table);
          this.state.tables.set(`${conn}.${table.name.toLowerCase()}`, table);
        }

        // Add unqualified fallback if not already registered
        if (!this.state.tables.has(table.fullName.toLowerCase())) {
          this.state.tables.set(table.fullName.toLowerCase(), table);
        }
        if (!this.state.tables.has(table.name.toLowerCase())) {
          this.state.tables.set(table.name.toLowerCase(), table);
        }
      }
    }
  }

  private findLocalDuckDBFile(config: PostgresConfig): string | null {
    if (config.duckdbDatabasePath && fs.existsSync(config.duckdbDatabasePath)) {
      return config.duckdbDatabasePath;
    }

    // Check workspace folders
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        const candidate = path.join(folder.uri.fsPath, 'mock_ducklake.duckdb');
        if (fs.existsSync(candidate)) {
          return candidate;
        }

        // Search for any .duckdb file in root of workspace
        try {
          const files = fs.readdirSync(folder.uri.fsPath);
          const duckFile = files.find(f => f.endsWith('.duckdb') || f === 'ducklake.db');
          if (duckFile) {
            return path.join(folder.uri.fsPath, duckFile);
          }
        } catch {
          // ignore
        }
      }
    }

    return null;
  }

  public async refreshCatalog(silent: boolean = false, targetConnectionName?: string): Promise<void> {
    const allConfigs = ConfigStorage.getAllConnections();
    const activeName = ConfigStorage.getActiveConnectionName();

    const configsToRefresh = targetConnectionName
      ? allConfigs.filter(c => c.connectionName === targetConnectionName || c.databaseAlias === targetConnectionName)
      : allConfigs;

    if (configsToRefresh.length === 0) {
      this.loadSampleSchema();
      return;
    }

    this.state.status = 'connecting';
    this.onDidChangeSchemaEmitter.fire(this.getState());

    let totalLoadedTables = 0;
    const errors: string[] = [];

    for (const config of configsToRefresh) {
      const connName = config.connectionName || 'lake';
      const alias = config.databaseAlias || connName;
      const isLocal = config.catalogType === 'local';

      try {
        let tables: TableMetadata[] = [];

        if (isLocal) {
          const dbPath = this.findLocalDuckDBFile(config);
          if (!dbPath) {
            throw new Error(`DuckDB file not found for "${connName}"`);
          }
          tables = await DuckDBLocalClient.fetchCatalog(dbPath);
        } else {
          const hasPgConfig = (config.connectionString && config.connectionString.trim().length > 0) ||
                              (config.host && config.password && config.database && config.user);
          if (!hasPgConfig) {
            throw new Error(`PostgreSQL parameters incomplete for "${connName}"`);
          }
          const client = new PostgresCatalogClient(config);
          tables = await client.fetchCatalog();
        }

        for (const t of tables) {
          t.databaseAlias = alias;
        }

        totalLoadedTables += tables.length;
        this.databaseCatalogs.set(connName, {
          connectionName: connName,
          databaseAlias: alias,
          status: 'connected',
          catalogType: isLocal ? 'local' : 'server',
          tables,
          lastRefreshed: new Date(),
          config
        });
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        console.error(`DuckLake: Error refreshing "${connName}":`, err);
        errors.push(`${connName}: ${errorMsg}`);

        this.databaseCatalogs.set(connName, {
          connectionName: connName,
          databaseAlias: alias,
          status: 'error',
          errorMessage: errorMsg,
          catalogType: isLocal ? 'local' : 'server',
          tables: [],
          lastRefreshed: new Date(),
          config
        });
      }
    }

    // Rebuild aggregate tables
    this.rebuildAggregateTables();

    // Determine overall state status
    const activeCatalog = this.getActiveDatabase();
    if (activeCatalog) {
      this.state.status = activeCatalog.status;
      this.state.errorMessage = activeCatalog.errorMessage;
    } else {
      const anyConnected = Array.from(this.databaseCatalogs.values()).some(d => d.status === 'connected');
      this.state.status = anyConnected ? 'connected' : (errors.length > 0 ? 'error' : 'disconnected');
      this.state.errorMessage = errors.join('; ');
    }

    this.state.lastRefreshed = new Date();
    this.onDidChangeSchemaEmitter.fire(this.getState());

    if (!silent) {
      if (errors.length > 0 && totalLoadedTables === 0) {
        vscode.window.showErrorMessage(`DuckLake: Catalog sync failed: ${errors.join(', ')}`);
      } else if (errors.length > 0) {
        vscode.window.showWarningMessage(`DuckLake: Synced with warnings: ${errors.join(', ')}`);
      } else {
        vscode.window.showInformationMessage(`DuckLake: Synced ${this.databaseCatalogs.size} database(s) (${totalLoadedTables} total tables)!`);
      }
    }

    const activeConfig = this.readConfig();
    this.setupAutoRefresh(activeConfig.autoRefreshMinutes);
  }

  public async testConnection(connectionName?: string): Promise<{ success: boolean; message: string }> {
    const config = this.readConfig(connectionName);
    if (config.catalogType === 'local') {
      const localDuckDB = this.findLocalDuckDBFile(config);
      if (localDuckDB) {
        try {
          const tables = await DuckDBLocalClient.fetchCatalog(localDuckDB);
          return {
            success: true,
            message: `Successfully connected to DuckDB: ${localDuckDB} (${tables.length} tables)`
          };
        } catch (err: any) {
          return {
            success: false,
            message: `DuckDB query failed: ${err.message}`
          };
        }
      }
      return {
        success: false,
        message: 'No local DuckDB database file found.'
      };
    }

    const client = new PostgresCatalogClient(config);
    return await client.testConnection();
  }

  private setupAutoRefresh(minutes: number): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }

    if (minutes > 0) {
      this.refreshTimer = setInterval(() => {
        this.refreshCatalog(true).catch(() => {});
      }, minutes * 60 * 1000);
    }
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    this.onDidChangeSchemaEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
