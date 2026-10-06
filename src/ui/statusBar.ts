import * as vscode from 'vscode';
import { SchemaManager } from '../catalog/schemaManager';
import { CatalogState } from '../catalog/types';

export class DuckLakeStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private schemaManager: SchemaManager;
  private disposables: vscode.Disposable[] = [];

  constructor(schemaManager: SchemaManager) {
    this.schemaManager = schemaManager;
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.statusBarItem.command = 'ducklake.showMenu';

    this.disposables.push(
      this.schemaManager.onDidChangeSchema((state) => {
        this.update(state);
      })
    );

    this.update(this.schemaManager.getState());
    this.statusBarItem.show();
  }

  public update(state: CatalogState): void {
    const tableCount = this.schemaManager.getTables().length;
    const activeDbName = this.schemaManager.getActiveDatabaseName();
    const dbs = this.schemaManager.getDatabases();
    const dbCount = dbs.length;

    switch (state.status) {
      case 'connected':
        this.statusBarItem.text = `$(database) DuckLake: ${activeDbName} (${tableCount} tables)`;
        this.statusBarItem.tooltip = `Connected to ${dbCount} database(s). Active: ${activeDbName}\nLast refreshed: ${state.lastRefreshed?.toLocaleTimeString() ?? 'just now'}\nClick for options.`;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'connecting':
        this.statusBarItem.text = `$(sync~spin) DuckLake: Syncing...`;
        this.statusBarItem.tooltip = `Fetching DuckLake metadata from catalogs...`;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'error':
        this.statusBarItem.text = `$(warning) DuckLake: Error`;
        this.statusBarItem.tooltip = `Failed to connect:\n${state.errorMessage}\nClick for options.`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;

      case 'disconnected':
      default:
        this.statusBarItem.text = `$(database) DuckLake: Sample Catalog`;
        this.statusBarItem.tooltip = `Running with sample DuckLake catalog.\nClick to configure database connections.`;
        this.statusBarItem.backgroundColor = undefined;
        break;
    }
  }

  public async showQuickPickMenu(): Promise<void> {
    const state = this.schemaManager.getState();
    const dbs = this.schemaManager.getDatabases();
    const activeName = this.schemaManager.getActiveDatabaseName();

    const items: (vscode.QuickPickItem & { action: string; extraData?: string })[] = [];

    if (dbs.length > 1) {
      items.push({
        label: `$(database) Switch Active Database (Current: ${activeName})`,
        description: 'Choose which database is primary for completions',
        action: 'switchDb'
      });
    }

    items.push(
      {
        label: '$(add) Add New Database Connection...',
        description: 'Connect another PostgreSQL metastore or local DuckDB file',
        action: 'addDb'
      },
      {
        label: '$(refresh) Refresh All Catalogs',
        description: 'Fetch the latest tables and columns from all databases',
        action: 'refresh'
      },
      {
        label: '$(plug) Test Connection',
        description: 'Verify connection credentials and reachability',
        action: 'test'
      },
      {
        label: '$(gear) Configure Databases (GUI)',
        description: 'Open DuckLake connection modal window',
        action: 'settings'
      },
      {
        label: '$(file-code) Open connections.json',
        description: 'Edit extension configuration file directly',
        action: 'openConfigFile'
      }
    );

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `DuckLake Catalogs (${dbs.length} DBs, ${state.status.toUpperCase()}) - Choose an action:`
    });

    if (!selected) {
      return;
    }

    switch (selected.action) {
      case 'switchDb': {
        const dbItems = dbs.map(d => ({
          label: `${d.databaseAlias || d.connectionName} ${d.connectionName === activeName ? '(Active)' : ''}`,
          description: `${d.catalogType === 'local' ? 'DuckDB' : 'PostgreSQL'} • ${d.tables.length} tables`,
          connName: d.connectionName
        }));
        const picked = await vscode.window.showQuickPick(dbItems, {
          placeHolder: 'Select active database:'
        });
        if (picked) {
          await this.schemaManager.setActiveDatabase(picked.connName);
          vscode.window.showInformationMessage(`DuckLake: Active database switched to "${picked.connName}"`);
        }
        break;
      }
      case 'addDb':
        vscode.commands.executeCommand('ducklake.addDatabase');
        break;
      case 'refresh':
        vscode.commands.executeCommand('ducklake.refreshCatalog');
        break;
      case 'test':
        vscode.commands.executeCommand('ducklake.testConnection');
        break;
      case 'settings':
        vscode.commands.executeCommand('ducklake.openSettings');
        break;
      case 'openConfigFile':
        vscode.commands.executeCommand('ducklake.openConfigFile');
        break;
    }
  }

  public dispose(): void {
    this.statusBarItem.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
