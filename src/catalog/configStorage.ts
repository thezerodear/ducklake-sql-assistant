import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PostgresConfig } from './types';

export interface StoredConnectionsFile {
  version: number;
  activeConnection?: string;
  connections: PostgresConfig[];
}

export class ConfigStorage {
  private static storageUri?: vscode.Uri;
  private static watcher?: vscode.FileSystemWatcher;
  private static isInternalSaving = false;
  private static _onDidChangeConfig = new vscode.EventEmitter<PostgresConfig>();
  public static readonly onDidChangeConfig = ConfigStorage._onDidChangeConfig.event;

  public static init(storageUri: vscode.Uri, context?: vscode.ExtensionContext): void {
    ConfigStorage.storageUri = storageUri;
    const dir = storageUri.fsPath;
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      console.error('DuckLake: Failed to create global storage directory:', err);
    }

    // Watch connections.json for external modifications
    try {
      if (ConfigStorage.watcher) {
        ConfigStorage.watcher.dispose();
      }
      ConfigStorage.watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(storageUri, 'connections.json')
      );
      ConfigStorage.watcher.onDidChange(() => {
        if (!ConfigStorage.isInternalSaving) {
          ConfigStorage._onDidChangeConfig.fire(ConfigStorage.loadConfig());
        }
      });
      ConfigStorage.watcher.onDidCreate(() => {
        if (!ConfigStorage.isInternalSaving) {
          ConfigStorage._onDidChangeConfig.fire(ConfigStorage.loadConfig());
        }
      });
      if (context) {
        context.subscriptions.push(ConfigStorage.watcher);
      }
    } catch (err) {
      console.error('DuckLake: Failed to initialize file watcher for connections.json:', err);
    }
  }

  public static getStorageFilePath(): string {
    if (ConfigStorage.storageUri) {
      return path.join(ConfigStorage.storageUri.fsPath, 'connections.json');
    }
    // Fallback if not initialized
    const appData = process.env.APPDATA || (process.platform === 'darwin' ? `${process.env.HOME}/Library/Application Support` : `${process.env.HOME}/.config`);
    return path.join(appData, 'Code', 'User', 'globalStorage', 'takdanai-mp.ducklake-sql-assistant', 'connections.json');
  }

  public static hasConfigFile(): boolean {
    const filePath = ConfigStorage.getStorageFilePath();
    return fs.existsSync(filePath);
  }

  public static readFromVscodeSettings(): PostgresConfig {
    const conf = vscode.workspace.getConfiguration('ducklake');
    return {
      connectionString: conf.get<string>('postgres.connectionString', ''),
      host: conf.get<string>('postgres.host', 'localhost'),
      port: conf.get<number>('postgres.port', 5439),
      database: conf.get<string>('postgres.database', 'ducklake_catalog'),
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
      clientEncoding: conf.get<string>('postgres.clientEncoding', 'auto'),
      dataStorage: conf.get<string>('dataStorage', 'local'),
      dataPath: conf.get<string>('dataPath', ''),
      overrideDataPath: conf.get<boolean>('overrideDataPath', false),
      databaseAlias: conf.get<string>('databaseAlias', 'lake')
    };
  }

  public static loadConnectionsFile(): StoredConnectionsFile | null {
    const filePath = ConfigStorage.getStorageFilePath();
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      if (!raw || !raw.trim()) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.connections)) {
        return parsed as StoredConnectionsFile;
      }
      if (parsed && typeof parsed === 'object') {
        const connName = parsed.connectionName || 'lake';
        return {
          version: 1,
          activeConnection: connName,
          connections: [{ ...parsed, connectionName: connName }]
        };
      }
    } catch (err) {
      console.error('DuckLake: Failed to parse connections.json:', err);
    }
    return null;
  }

  public static loadConfig(): PostgresConfig {
    const defaultSettings = ConfigStorage.readFromVscodeSettings();
    const fileData = ConfigStorage.loadConnectionsFile();

    if (!fileData || !fileData.connections || fileData.connections.length === 0) {
      return defaultSettings;
    }

    let active = fileData.connections.find(
      c => c.connectionName === fileData.activeConnection
    );
    if (!active) {
      active = fileData.connections[0];
    }

    return {
      ...defaultSettings,
      ...active
    };
  }

  public static async saveConfig(config: PostgresConfig): Promise<void> {
    const filePath = ConfigStorage.getStorageFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let fileData = ConfigStorage.loadConnectionsFile();
    const targetName = config.connectionName?.trim() || 'lake';
    const normalizedConfig: PostgresConfig = {
      ...config,
      connectionName: targetName
    };

    if (!fileData) {
      if (fs.existsSync(filePath)) {
        try {
          const rawExisting = fs.readFileSync(filePath, 'utf-8');
          if (rawExisting.trim().length > 0) {
            fs.writeFileSync(filePath + '.bak', rawExisting, 'utf-8');
          }
        } catch (_) {}
      }
      fileData = {
        version: 1,
        activeConnection: targetName,
        connections: [normalizedConfig]
      };
    } else {
      fileData.activeConnection = targetName;
      if (!Array.isArray(fileData.connections)) {
        fileData.connections = [];
      }
      const idx = fileData.connections.findIndex(c => c.connectionName === targetName);
      if (idx >= 0) {
        fileData.connections[idx] = { ...fileData.connections[idx], ...normalizedConfig };
      } else {
        fileData.connections.push(normalizedConfig);
      }
    }

    ConfigStorage.isInternalSaving = true;
    try {
      fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2), 'utf-8');
      ConfigStorage._onDidChangeConfig.fire(ConfigStorage.loadConfig());
    } finally {
      setTimeout(() => {
        ConfigStorage.isInternalSaving = false;
      }, 500);
    }
  }

  public static getAllConnections(): PostgresConfig[] {
    const fileData = ConfigStorage.loadConnectionsFile();
    if (fileData && fileData.connections && fileData.connections.length > 0) {
      return fileData.connections;
    }
    return [ConfigStorage.readFromVscodeSettings()];
  }

  public static async setActiveConnection(name: string): Promise<boolean> {
    const fileData = ConfigStorage.loadConnectionsFile();
    if (!fileData || !fileData.connections) {
      return false;
    }
    const found = fileData.connections.find(c => c.connectionName === name);
    if (!found) {
      return false;
    }
    fileData.activeConnection = name;
    const filePath = ConfigStorage.getStorageFilePath();
    fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2), 'utf-8');
    ConfigStorage._onDidChangeConfig.fire(ConfigStorage.loadConfig());
    return true;
  }
}
