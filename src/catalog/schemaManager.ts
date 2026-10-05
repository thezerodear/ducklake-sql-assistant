import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PostgresCatalogClient } from './postgresClient';
import { DuckDBLocalClient } from './duckdbClient';
import { TableMetadata, ColumnMetadata, PostgresConfig, CatalogState, ConnectionState } from './types';
import { ConfigStorage } from './configStorage';

export class SchemaManager implements vscode.Disposable {
  private client: PostgresCatalogClient;
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
      tables: new Map<string, TableMetadata>()
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

  public readConfig(): PostgresConfig {
    return ConfigStorage.loadConfig();
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
      if (parts.length >= 2) {
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
      this.state.tables.set(table.fullName.toLowerCase(), table);
      if (!this.state.tables.has(table.name.toLowerCase())) {
        this.state.tables.set(table.name.toLowerCase(), table);
      }
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

    // 1. Try PostgreSQL Catalog if connection is configured (or catalogType === 'server')
    const hasPgConfig = (config.connectionString && config.connectionString.trim().length > 0) ||
                        (config.host && config.password && config.database && config.user);

    if (config.catalogType !== 'local' && hasPgConfig) {
      this.state.status = 'connecting';
      this.onDidChangeSchemaEmitter.fire(this.state);
      try {
        const tables = await this.client.fetchCatalog();
        this.setTables(tables, 'connected');
        if (!silent) {
          vscode.window.showInformationMessage(`DuckLake: Synced ${tables.length} tables/views from PostgreSQL catalog!`);
        }
        this.setupAutoRefresh(config.autoRefreshMinutes);
        return;
      } catch (err: any) {
        const errorMsg = err?.message || String(err);
        console.error('DuckLake: Postgres catalog fetch error:', err);
        // Show actual error and halt before fallback
        this.setTables([], 'error', errorMsg);
        vscode.window.showErrorMessage(`DuckLake: Failed to connect to PostgreSQL catalog: ${errorMsg}`);
        return; // STOP! Do not silently fallback to sample catalog
      }
    }

    // 2. Try Local DuckDB file if configured (or catalogType === 'local')
    if (config.catalogType === 'local') {
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
          const errorMsg = err?.message || String(err);
          console.error('DuckLake: DuckDB local fetch error:', err);
          this.setTables([], 'error', errorMsg);
          vscode.window.showErrorMessage(`DuckLake: Failed to load local DuckDB file: ${errorMsg}`);
          return; // STOP!
        }
      } else {
        const errorMsg = 'Local DuckDB database file not found. Please configure path in connection settings.';
        this.setTables([], 'error', errorMsg);
        if (!silent) {
          vscode.window.showErrorMessage(`DuckLake: ${errorMsg}`);
        }
        return;
      }
    }

    // 3. Fallback to sample catalog ONLY if nothing is configured
    this.loadSampleSchema();
    if (!silent) {
      vscode.window.showInformationMessage('DuckLake: Using sample catalog. Connect Postgres or specify a local DuckDB file in settings.');
    }

    this.setupAutoRefresh(config.autoRefreshMinutes);
  }

  public async testConnection(): Promise<{ success: boolean; message: string }> {
    const config = this.readConfig();
    if (config.catalogType === 'local') {
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
      return {
        success: false,
        message: 'No local DuckDB database file found.'
      };
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
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
