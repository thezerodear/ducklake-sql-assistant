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

    switch (state.status) {
      case 'connected':
        this.statusBarItem.text = `$(database) DuckLake: Connected (${tableCount} tables)`;
        this.statusBarItem.tooltip = `Postgres DuckLake Catalog is connected.\nLast refreshed: ${state.lastRefreshed?.toLocaleTimeString() ?? 'just now'}\nClick for options.`;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'connecting':
        this.statusBarItem.text = `$(sync~spin) DuckLake: Syncing...`;
        this.statusBarItem.tooltip = `Fetching DuckLake metadata from PostgreSQL catalog...`;
        this.statusBarItem.backgroundColor = undefined;
        break;

      case 'error':
        this.statusBarItem.text = `$(warning) DuckLake: Error`;
        this.statusBarItem.tooltip = `Failed to connect to PostgreSQL catalog:\n${state.errorMessage}\nClick for options.`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;

      case 'disconnected':
      default:
        this.statusBarItem.text = `$(database) DuckLake: Sample Catalog`;
        this.statusBarItem.tooltip = `Running with sample DuckLake catalog.\nClick to configure PostgreSQL connection.`;
        this.statusBarItem.backgroundColor = undefined;
        break;
    }
  }

  public async showQuickPickMenu(): Promise<void> {
    const state = this.schemaManager.getState();
    const items: (vscode.QuickPickItem & { action: string })[] = [
      {
        label: '$(refresh) Refresh Catalog Metadata',
        description: 'Fetch the latest tables and columns from PostgreSQL',
        action: 'refresh'
      },
      {
        label: '$(plug) Test Connection',
        description: 'Verify PostgreSQL catalog credentials and reachability',
        action: 'test'
      },
      {
        label: '$(gear) Configure Connection (GUI)',
        description: 'Open DuckLake connection modal window',
        action: 'settings'
      },
      {
        label: '$(file-code) Open connections.json',
        description: 'Edit extension configuration file directly',
        action: 'openConfigFile'
      }
    ];

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `DuckLake Catalog (${state.status.toUpperCase()}) - Choose an action:`
    });

    if (!selected) {
      return;
    }

    switch (selected.action) {
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
