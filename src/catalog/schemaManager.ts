import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PostgresCatalogClient } from './postgresClient';
import { DuckDBLocalClient } from './duckdbClient';
import { TableMetadata, ColumnMetadata, PostgresConfig, CatalogState, ConnectionState } from './types';

export class SchemaManager implements vscode.Disposable {
  private client: PostgresCatalogClient;
  private state: CatalogState;
  private refreshTimer?: NodeJS.Timeout;
  private onDidChangeSchemaEmitter = new vscode.EventEmitter<CatalogState>();
  public readonly onDidChangeSchema = this.onDidChangeSchemaEmitter.event;

  constructor() {
    const config = this.readConfig();
    this.client = new PostgresCatalogClient(config);
    this.state = {
      status: 'disconnected',
      tables: new Map<string, TableMetadata>()
    };

    // Load initial schema
    this.refreshCatalog(true).catch(() => {
      this.loadSampleSchema();
    });
  }

  public readConfig(): PostgresConfig {
    const conf = vscode.workspace.getConfiguration('ducklake');
    return {
      connectionString: conf.get<string>('postgres.connectionString', ''),
      host: conf.get<string>('postgres.host', 'localhost'),
      port: conf.get<number>('postgres.port', 5432),
      database: conf.get<string>('postgres.database', 'postgres'),
      user: conf.get<string>('postgres.user', 'postgres'),
      password: conf.get<string>('postgres.password', ''),
      ssl: conf.get<boolean>('postgres.ssl', false),
      catalogSchemas: conf.get<string[]>('catalogSchemas', ['public', 'main']),
      autoRefreshMinutes: conf.get<number>('autoRefreshMinutes', 10),
      enableSmartHeuristic: conf.get<boolean>('enableSmartHeuristic', true),
      suggestDuckDBFunctions: conf.get<boolean>('suggestDuckDBFunctions', true),
      duckdbDatabasePath: conf.get<string>('duckdb.databasePath', ''),
      alwaysEnableInTripleQuotes: conf.get<boolean>('alwaysEnableInTripleQuotes', true),
      connectionName: conf.get<string>('connectionName', 'lake'),
      catalogType: conf.get<string>('catalogType', 'server'),
      dataStorage: conf.get<string>('dataStorage', 'local'),
      dataPath: conf.get<string>('dataPath', ''),
      overrideDataPath: conf.get<boolean>('overrideDataPath', false),
      databaseAlias: conf.get<string>('databaseAlias', 'lake')
    };
  }

  public getState(): CatalogState {
    return this.state;
  }

  public getTables(): TableMetadata[] {
    const unique = new Set<TableMetadata>();
    for (const table of this.state.tables.values()) {
      unique.add(table);
    }
    return Array.from(unique);
  }

  public findTable(nameOrAlias: string): TableMetadata | undefined {
    let clean = nameOrAlias.toLowerCase().trim().replace(/["`]/g, '');
    if (this.state.tables.has(clean)) {
      return this.state.tables.get(clean);
    }
    if (clean.includes('.')) {
      const parts = clean.split('.');
      const simple = parts[parts.length - 1];
      if (this.state.tables.has(simple)) {
        return this.state.tables.get(simple);
      }
    }
    return undefined;
  }

  public getAllColumns(): { column: ColumnMetadata; table: TableMetadata }[] {
    const result: { column: ColumnMetadata; table: TableMetadata }[] = [];
    const tables = this.getTables();
    for (const table of tables) {
      for (const column of table.columns) {
        result.push({ column, table });
      }
    }
    return result;
  }

  public getColumnsForTable(tableName: string): ColumnMetadata[] {
    const table = this.findTable(tableName);
    return table ? table.columns : [];
  }

  public loadSampleSchema(): void {
    const samples = PostgresCatalogClient.getSampleCatalog();
    this.setTables(samples, 'disconnected');
  }

  private setTables(tables: TableMetadata[], status: ConnectionState, errorMessage?: string): void {
    this.state.tables.clear();
    for (const table of tables) {
      this.state.tables.set(table.name.toLowerCase(), table);
      this.state.tables.set(table.fullName.toLowerCase(), table);
    }
    this.state.status = status;
    this.state.lastRefreshed = new Date();
    this.state.errorMessage = errorMessage;
    this.onDidChangeSchemaEmitter.fire(this.state);
  }

  private findLocalDuckDBFile(): string | null {
    const config = this.readConfig();
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

  public async refreshCatalog(silent: boolean = false): Promise<void> {
    const config = this.readConfig();
    this.client.updateConfig(config);

    // 1. Try PostgreSQL Catalog if connection is configured
    const hasPgConfig = (config.connectionString && config.connectionString.trim().length > 0) ||
                        (config.host && config.password && config.database && config.user);

    if (hasPgConfig) {
      this.state.status = 'connecting';
      this.onDidChangeSchemaEmitter.fire(this.state);
      try {
        const tables = await this.client.fetchCatalog();
        this.setTables(tables, 'connected');
        if (!silent) {
          vscode.window.showInformationMessage(`DuckLake: Synced ${tables.length} tables from PostgreSQL catalog!`);
        }
        this.setupAutoRefresh(config.autoRefreshMinutes);
        return;
      } catch (err: any) {
        console.error('Postgres catalog fetch error:', err);
      }
    }

    // 2. Try Local DuckDB file if available
    const localDuckDB = this.findLocalDuckDBFile();
    if (localDuckDB) {
      try {
        const tables = await DuckDBLocalClient.fetchCatalog(localDuckDB);
        this.setTables(tables, 'connected');
        if (!silent) {
          vscode.window.showInformationMessage(`DuckLake: Loaded ${tables.length} tables from DuckDB (${path.basename(localDuckDB)})!`);
        }
        return;
      } catch (err: any) {
        console.error('DuckDB local fetch error:', err);
      }
    }

    // 3. Fallback to sample catalog
    this.loadSampleSchema();
    if (!silent) {
      vscode.window.showInformationMessage('DuckLake: Using sample catalog. Connect Postgres or specify a local DuckDB file in settings.');
    }

    this.setupAutoRefresh(config.autoRefreshMinutes);
  }

  public async testConnection(): Promise<{ success: boolean; message: string }> {
    const config = this.readConfig();
    const localDuckDB = this.findLocalDuckDBFile();
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

    this.client.updateConfig(config);
    return await this.client.testConnection();
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
  }
}
