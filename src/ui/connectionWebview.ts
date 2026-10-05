import * as vscode from 'vscode';
import * as fs from 'fs';
import { SchemaManager } from '../catalog/schemaManager';
import { PostgresCatalogClient } from '../catalog/postgresClient';
import { PostgresConfig } from '../catalog/types';
import { ConfigStorage } from '../catalog/configStorage';

export class DuckLakeConnectionWebview {
  public static currentPanel: DuckLakeConnectionWebview | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  public static show(extensionUri: vscode.Uri, schemaManager: SchemaManager) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DuckLakeConnectionWebview.currentPanel) {
      DuckLakeConnectionWebview.currentPanel.panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ducklakeConnection',
      'DuckLake: Connect Catalog',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    DuckLakeConnectionWebview.currentPanel = new DuckLakeConnectionWebview(
      panel,
      extensionUri,
      schemaManager
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private schemaManager: SchemaManager
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    const currentConfig = this.schemaManager.readConfig();
    this.panel.webview.html = this.getHtmlContent(currentConfig);

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'test':
            await this.handleTest(message.data);
            break;
          case 'save':
            await this.handleSave(message.data);
            break;
          case 'cancel':
            this.panel.dispose();
            break;
          case 'browseDataPath':
            await this.handleBrowseDataPath();
            break;
          case 'browseCatalog':
            await this.handleBrowseCatalog();
            break;
          case 'copyPythonCode':
            await this.handleCopyPythonCode(message.data);
            break;
          case 'openConfigFile':
            await vscode.commands.executeCommand('ducklake.openConfigFile');
            break;
        }
      },
      null,
      this.disposables
    );
  }

  private async handleCopyPythonCode(data: any): Promise<void> {
    const connStr = data.catalogConnection?.trim() || data.connectionString?.trim() || '';
    const alias = data.databaseAlias?.trim() || 'lake';
    let dataPathClause = '';
    if (data.dataPath && data.overrideDataPath) {
      const cleanPath = data.dataPath.trim().replace(/\\/g, '/');
      dataPathClause = ` (DATA_PATH '${cleanPath}')`;
    }

    const snippet = `import duckdb

# 1. Connect DuckDB
con = duckdb.connect()

# 2. Install & load ducklake and postgres extensions
con.execute("INSTALL ducklake; INSTALL postgres;")
con.execute("LOAD ducklake; LOAD postgres;")

# 3. Attach DuckLake Catalog
con.execute("""
    ATTACH 'ducklake:postgres:${connStr}' 
    AS ${alias}${dataPathClause};
""")

# 4. Use database
con.execute("USE ${alias};")
con.sql("SHOW TABLES;").show()
`;

    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage('DuckLake: Python connect code copied to clipboard!');
  }

  private async handleBrowseDataPath(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select DuckLake Data Directory'
    });

    if (selected && selected.length > 0) {
      this.panel.webview.postMessage({
        command: 'setDataPath',
        path: selected[0].fsPath
      });
    }
  }

  private async handleBrowseCatalog(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select Local DuckDB Database File',
      filters: {
        'DuckDB / SQLite Files': ['duckdb', 'db', 'sqlite', 'ducklake']
      }
    });

    if (selected && selected.length > 0) {
      this.panel.webview.postMessage({
        command: 'setCatalogConnection',
        path: selected[0].fsPath
      });
    }
  }

  private async handleTest(data: any): Promise<void> {
    const catalogType = data.catalogType || 'server';

    if (catalogType === 'local') {
      // Test local DuckDB file path
      const filePath = data.catalogConnection?.trim() || '';
      if (!filePath) {
        const msg = 'Please specify a local DuckDB database file path.';
        vscode.window.showErrorMessage(`DuckLake: ${msg}`);
        this.panel.webview.postMessage({ command: 'testResult', success: false, message: msg });
        return;
      }

      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        const msg = `Local database file found! (${(stat.size / 1024).toFixed(1)} KB) - ${filePath}`;
        vscode.window.showInformationMessage(`DuckLake: ${msg}`);
        this.panel.webview.postMessage({ command: 'testResult', success: true, message: msg });
      } else {
        const msg = `Local file does not exist: ${filePath}`;
        vscode.window.showErrorMessage(`DuckLake: ${msg}`);
        this.panel.webview.postMessage({ command: 'testResult', success: false, message: msg });
      }
      return;
    }

    // Database Server (PostgreSQL)
    const connStr = data.catalogConnection?.trim() || data.connectionString?.trim() || '';
    const parsed = PostgresCatalogClient.parseConnString(connStr);

    const testConfig: PostgresConfig = {
      connectionString: connStr,
      host: parsed.host || data.host || 'localhost',
      port: parsed.port || parseInt(data.port, 10) || 5439,
      database: parsed.database || data.database || 'ducklake_catalog',
      user: parsed.user || data.user || 'postgres',
      password: parsed.password !== undefined ? parsed.password : (data.password || ''),
      ssl: !!data.ssl,
      catalogSchemas: ['main', 'public'],
      autoRefreshMinutes: 5,
      enableSmartHeuristic: true,
      suggestDuckDBFunctions: true,
      alwaysEnableInTripleQuotes: true,
      clientEncoding: this.schemaManager.readConfig().clientEncoding || 'auto'
    };

    const client = new PostgresCatalogClient(testConfig);
    try {
      const result = await client.testConnection();
      if (result.success) {
        vscode.window.showInformationMessage(`DuckLake: ${result.message}`);
      } else {
        vscode.window.showErrorMessage(`DuckLake: ${result.message}`);
      }

      this.panel.webview.postMessage({
        command: 'testResult',
        success: result.success,
        message: result.message
      });
    } catch (err: any) {
      const errMsg = err.message || String(err);
      vscode.window.showErrorMessage(`DuckLake: ${errMsg}`);
      this.panel.webview.postMessage({
        command: 'testResult',
        success: false,
        message: errMsg
      });
    }
  }

  private async handleSave(data: any): Promise<void> {
    try {
      const isLocal = data.catalogType === 'local';
      const current = this.schemaManager.readConfig();
      const connName = data.connectionName?.trim() || 'lake';

      let newConfig: PostgresConfig;

      if (isLocal) {
        newConfig = {
          ...current,
          connectionName: connName,
          catalogType: 'local',
          duckdbDatabasePath: data.catalogConnection?.trim() || '',
          databaseAlias: data.databaseAlias?.trim() || 'lake',
          dataPath: data.dataPath?.trim() || '',
          overrideDataPath: !!data.overrideDataPath
        };
      } else {
        const connStr = data.catalogConnection?.trim() || data.connectionString?.trim() || '';
        const parsed = PostgresCatalogClient.parseConnString(connStr);

        const host = parsed.host || data.host || current.host || 'localhost';
        const port = parsed.port || parseInt(data.port, 10) || current.port || 5439;
        const database = parsed.database || data.database || current.database || 'ducklake_catalog';
        const user = parsed.user || data.user || current.user || 'postgres';
        const password = parsed.password !== undefined ? parsed.password : (data.password !== undefined ? data.password : (current.password || ''));

        newConfig = {
          ...current,
          connectionName: connName,
          catalogType: 'server',
          connectionString: connStr,
          host,
          port,
          database,
          user,
          password,
          ssl: !!data.ssl,
          databaseAlias: data.databaseAlias?.trim() || 'lake',
          dataPath: data.dataPath?.trim() || '',
          overrideDataPath: !!data.overrideDataPath
        };
      }

      await ConfigStorage.saveConfig(newConfig);

      // Refresh catalog with new parameters
      await this.schemaManager.refreshCatalog(false);

      vscode.window.showInformationMessage(`DuckLake: Connection "${connName}" saved to connections.json & catalog synchronized!`);
      this.panel.dispose();
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      vscode.window.showErrorMessage(`DuckLake: Failed to save settings: ${errMsg}`);
      this.panel.webview.postMessage({
        command: 'testResult',
        success: false,
        message: `Save error: ${errMsg}`
      });
    }
  }

  public dispose() {
    DuckLakeConnectionWebview.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const x = this.disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  private getHtmlContent(config: PostgresConfig): string {
    const connName = config.connectionName || 'lake';
    const isLocal = config.catalogType === 'local';
    const catalogConn = isLocal
      ? (config.duckdbDatabasePath || '')
      : (config.connectionString && config.connectionString.trim().length > 0
          ? config.connectionString
          : `postgres:host=${config.host || 'localhost'} port=${config.port || 5439} dbname=${config.database || 'ducklake_catalog'} user=${config.user || 'postgres'} password=${config.password || ''}`);

    const dataPath = config.dataPath || '';
    const overrideDataPath = config.overrideDataPath !== undefined ? config.overrideDataPath : false;
    const databaseAlias = config.databaseAlias || 'lake';
    const storagePath = ConfigStorage.getStorageFilePath().replace(/\\/g, '/');

    const escapeHtml = (unsafe: any): string => {
      return String(unsafe ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    return /* html */ `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edit: ${escapeHtml(connName)}</title>
  <style>
    :root {
      --bg: #141517;
      --card-bg: #1a1c20;
      --input-bg: #111215;
      --input-border: #2c2f36;
      --input-focus: #0288d1;
      --text-main: #e2e8f0;
      --text-muted: #94a3b8;
      --accent: #0288d1;
      --accent-hover: #0277bd;
      --border-color: #262930;
      --success: #22c55e;
      --error: #ef4444;
    }

    * {
      box-sizing: border-box;
    }

    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
      margin: 0;
      padding: 24px;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      min-height: 100vh;
    }

    .modal-card {
      width: 100%;
      max-width: 640px;
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 10px;
      padding: 24px 28px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
    }

    /* Header */
    .top-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .btn-back {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 18px;
      display: flex;
      align-items: center;
      padding: 4px;
      border-radius: 4px;
    }
    .btn-back:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.05);
    }

    .brand-icon {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #0288d1;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 17px;
      color: #fff;
      box-shadow: 0 0 10px rgba(2, 136, 209, 0.4);
    }

    .header-title {
      font-size: 18px;
      font-weight: 600;
      color: #fff;
      letter-spacing: -0.2px;
    }

    .import-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #38bdf8;
      font-size: 12.5px;
      cursor: pointer;
      text-decoration: none;
      background: transparent;
      border: none;
      padding: 4px 8px;
      border-radius: 4px;
    }
    .import-link:hover {
      background: rgba(56, 189, 248, 0.1);
      text-decoration: underline;
    }

    /* Form Fields */
    .field-group {
      margin-bottom: 18px;
    }

    .field-label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--text-main);
      margin-bottom: 7px;
    }

    .req-star {
      color: var(--accent);
      font-weight: bold;
    }

    .info-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 1px solid var(--text-muted);
      color: var(--text-muted);
      font-size: 10px;
      cursor: help;
    }

    .sub-hint {
      font-size: 11.5px;
      color: var(--text-muted);
      margin-top: 5px;
      line-height: 1.4;
    }

    input[type="text"],
    input[type="number"],
    input[type="password"] {
      width: 100%;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 6px;
      padding: 9px 12px;
      color: #fff;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s ease;
    }

    input[type="text"]:focus,
    input[type="number"]:focus,
    input[type="password"]:focus {
      border-color: var(--input-focus);
    }

    /* Input With Action Button */
    .input-action-row {
      display: flex;
      gap: 8px;
    }

    .input-action-row input {
      flex: 1;
    }

    .btn-action-side {
      background: #23272f;
      border: 1px solid var(--input-border);
      color: var(--text-main);
      padding: 0 14px;
      border-radius: 6px;
      font-size: 12.5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .btn-action-side:hover {
      background: #2c313b;
      color: #fff;
    }

    /* Segmented Controls */
    .segmented-control {
      display: flex;
      background: #111215;
      border: 1px solid var(--input-border);
      border-radius: 6px;
      padding: 3px;
      gap: 3px;
    }

    .segmented-btn {
      flex: 1;
      text-align: center;
      padding: 7px 10px;
      font-size: 12.5px;
      border-radius: 4px;
      cursor: pointer;
      color: var(--text-muted);
      border: none;
      background: transparent;
      transition: all 0.15s ease;
      white-space: nowrap;
    }

    .segmented-btn:hover {
      color: #fff;
    }

    .segmented-btn.active {
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      box-shadow: 0 2px 6px rgba(2, 136, 209, 0.35);
    }

    /* Switch Toggle */
    .switch-container {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 14px;
      margin-bottom: 18px;
    }

    .switch-info {
      flex: 1;
      padding-right: 16px;
    }

    .switch-title {
      font-size: 13px;
      font-weight: 500;
      color: #fff;
    }

    .switch-desc {
      font-size: 11.5px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    .switch-pill {
      position: relative;
      display: inline-block;
      width: 44px;
      height: 24px;
      flex-shrink: 0;
    }

    .switch-pill input {
      opacity: 0;
      width: 0;
      height: 0;
    }

    .slider {
      position: absolute;
      cursor: pointer;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: #2b2e36;
      transition: .2s;
      border-radius: 24px;
    }

    .slider:before {
      position: absolute;
      content: "";
      height: 18px;
      width: 18px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .2s;
      border-radius: 50%;
    }

    input:checked + .slider {
      background-color: var(--accent);
    }

    input:checked + .slider:before {
      transform: translateX(20px);
    }

    /* Collapsible Section */
    .accordion-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 0;
      font-size: 12.5px;
      color: var(--text-muted);
      cursor: pointer;
      border-top: 1px solid var(--border-color);
      margin-top: 16px;
      user-select: none;
    }
    .accordion-header:hover {
      color: #fff;
    }

    .accordion-content {
      display: none;
      padding: 12px 0;
    }
    .accordion-content.open {
      display: block;
    }

    /* Live Test Banner */
    .test-banner {
      display: none;
      padding: 12px 16px;
      border-radius: 6px;
      font-size: 13px;
      margin-top: 18px;
      line-height: 1.5;
    }

    .test-banner.info {
      display: block;
      background: rgba(2, 136, 209, 0.15);
      border: 1px solid #0288d1;
      color: #38bdf8;
    }

    .test-banner.success {
      display: block;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid #22c55e;
      color: #4ade80;
    }

    .test-banner.error {
      display: block;
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid #ef4444;
      color: #f87171;
    }

    /* Footer */
    .footer-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 24px;
      padding-top: 18px;
      border-top: 1px solid var(--border-color);
    }

    .btn-test {
      background: #23272f;
      border: 1px solid #3b4252;
      color: #fff;
      padding: 9px 18px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      transition: background 0.15s, border-color 0.15s;
    }
    .btn-test:hover {
      background: #2d323c;
      border-color: #0288d1;
    }

    .footer-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .btn-cancel {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 13px;
      cursor: pointer;
      padding: 9px 14px;
      border-radius: 6px;
    }
    .btn-cancel:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.05);
    }

    .btn-save {
      background: var(--accent);
      border: none;
      color: #fff;
      font-size: 13px;
      font-weight: 600;
      padding: 9px 20px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
      box-shadow: 0 2px 8px rgba(2, 136, 209, 0.35);
    }
    .btn-save:hover {
      background: var(--accent-hover);
    }

    /* Import Modal Overlay */
    .import-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.65);
      z-index: 99;
      justify-content: center;
      align-items: center;
    }
    .import-modal.show {
      display: flex;
    }

    .import-box {
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 20px;
      width: 90%;
      max-width: 520px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.7);
    }
    .import-box h3 {
      margin-top: 0;
      margin-bottom: 8px;
      font-size: 15px;
      color: #fff;
    }
    .import-box p {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }
    .import-box textarea {
      width: 100%;
      height: 90px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: 6px;
      color: #fff;
      padding: 8px 10px;
      font-family: monospace;
      font-size: 12px;
      outline: none;
      resize: vertical;
    }
    .import-box-buttons {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 14px;
    }
  </style>
</head>
<body>
  <div class="modal-card">
    <!-- Top Header -->
    <div class="top-header">
      <div class="header-left">
        <button class="btn-back" id="btnBack" title="Cancel & Close">←</button>
        <div class="brand-icon">🦆</div>
        <div class="header-title" id="headerTitle">Edit: ${escapeHtml(connName)}</div>
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="import-link" id="btnOpenConfig" title="Open configuration file (connections.json)">
          <span>📁</span> connections.json
        </button>
        <button class="import-link" id="btnOpenImport">
          <span>🔗</span> Import connection string
        </button>
      </div>
    </div>

    <!-- Connection Name -->
    <div class="field-group">
      <div class="field-label">Connection name <span class="req-star">*</span></div>
      <input type="text" id="connName" value="${escapeHtml(connName)}" placeholder="lake" />
    </div>

    <!-- Catalog Type -->
    <div class="field-group">
      <div class="field-label">Catalog Type <span class="req-star">*</span></div>
      <div class="segmented-control" id="catalogTypeSeg">
        <button class="segmented-btn ${isLocal ? '' : 'active'}" data-val="server">Database Server (PostgreSQL)</button>
        <button class="segmented-btn ${isLocal ? 'active' : ''}" data-val="local">Local DuckDB File (.duckdb)</button>
      </div>
      <div class="sub-hint" id="catalogTypeHint">${isLocal ? 'Local DuckDB database file (.duckdb)' : 'PostgreSQL catalog metadata backend (DuckLake metastore tables)'}</div>
    </div>

    <!-- Catalog Connection -->
    <div class="field-group">
      <div class="field-label">
        <span id="connLabelText">${isLocal ? 'DuckDB Database Path' : 'Catalog Connection'}</span> <span class="req-star">*</span>
        <span class="info-icon" title="PostgreSQL connection string or local .duckdb file path">ℹ</span>
      </div>
      <div class="input-action-row">
        <input type="text" id="catalogConn" value="${escapeHtml(catalogConn)}" placeholder="${isLocal ? 'C:\\path\\to\\my_lake.duckdb' : 'postgres:host=localhost port=5439 dbname=ducklake_catalog user=postgres password=...'}" />
        <button class="btn-action-side" id="btnBrowseCatalog" title="Configure details or browse database file">${isLocal ? 'Browse File' : 'Parameters'}</button>
      </div>
    </div>

    <!-- Data Path -->
    <div class="field-group">
      <div class="field-label">
        Data Path
        <span class="info-icon" title="Local directory or UNC path storing DuckLake Parquet data files (optional if catalog has data_path)">ℹ</span>
      </div>
      <div class="input-action-row">
        <input type="text" id="dataPath" value="${escapeHtml(dataPath)}" placeholder="C:\\path\\to\\data or \\\\fileserver\\share\\data" />
        <button class="btn-action-side" id="btnBrowseDataPath" title="Browse Local or Network Folder">📁</button>
      </div>
      <div class="sub-hint">Supports local paths (e.g. C:/data) and Windows UNC network paths (e.g. //fileserver/share/data)</div>
    </div>

    <!-- Override Data Path Switch -->
    <div class="switch-container">
      <div class="switch-info">
        <div class="switch-title">Override Data Path</div>
        <div class="switch-desc">Override the data path stored in the catalog with the one specified above.</div>
      </div>
      <label class="switch-pill">
        <input type="checkbox" id="overrideDataPath" ${overrideDataPath ? 'checked' : ''}>
        <span class="slider"></span>
      </label>
    </div>

    <!-- Database Alias -->
    <div class="field-group">
      <div class="field-label">
        Database Alias
        <span class="info-icon" title="Alias name used inside DuckDB queries (e.g. con.sql('SELECT * FROM lake.main.customers'))">ℹ</span>
      </div>
      <input type="text" id="dbAlias" value="${escapeHtml(databaseAlias)}" placeholder="lake" />
    </div>

    <!-- Advanced Settings Accordion -->
    <div class="accordion-header" id="accToggle" style="display: ${isLocal ? 'none' : 'flex'};">
      <span>⚙️ Connection Parameters (Host, Port, Database, User, Password)</span>
      <span id="accChevron">▼</span>
    </div>
    <div class="accordion-content" id="accContent">
      <div class="field-group" style="display: flex; gap: 12px;">
        <div style="flex: 2;">
          <div class="field-label">Host</div>
          <input type="text" id="advHost" value="${escapeHtml(config.host || 'localhost')}" />
        </div>
        <div style="flex: 1;">
          <div class="field-label">Port</div>
          <input type="number" id="advPort" value="${config.port || 5439}" />
        </div>
      </div>
      <div class="field-group" style="display: flex; gap: 12px;">
        <div style="flex: 1;">
          <div class="field-label">Database Name</div>
          <input type="text" id="advDb" value="${escapeHtml(config.database || 'ducklake_catalog')}" />
        </div>
        <div style="flex: 1;">
          <div class="field-label">Username</div>
          <input type="text" id="advUser" value="${escapeHtml(config.user || 'postgres')}" />
        </div>
      </div>
      <div class="field-group">
        <div class="field-label">Password</div>
        <input type="password" id="advPass" value="${escapeHtml(config.password || '')}" placeholder="••••••••" />
      </div>
    </div>

    <!-- Test Feedback Banner -->
    <div id="testBanner" class="test-banner"></div>

    <!-- Footer Bar -->
    <div class="footer-bar">
      <div style="display: flex; gap: 8px;">
        <button class="btn-test" id="btnTest">
          <span>⚡</span> Test
        </button>
        <button class="btn-action-side" id="btnCopyPython" title="Copy ready-to-run Python connect code to clipboard">
          <span>📋</span> Copy Python Code
        </button>
      </div>

      <div class="footer-right">
        <button class="btn-cancel" id="btnCancel">Cancel</button>
        <button class="btn-save" id="btnSave">Save connection</button>
      </div>
    </div>

    <div style="margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-muted);">
      <span>🔒 Stored in: <code style="color: #38bdf8; font-size: 11px;">${storagePath}</code></span>
      <span style="color: #64748b;">(Not in repo)</span>
    </div>
  </div>

  <!-- Import Modal Overlay -->
  <div class="import-modal" id="importModal">
    <div class="import-box">
      <h3>Import Connection String</h3>
      <p>Paste DuckLake / PostgreSQL connection URI or key-value string:</p>
      <textarea id="importStringText" placeholder="postgres:host=localhost port=5439 dbname=ducklake_catalog user=postgres password=..."></textarea>
      <div class="import-box-buttons">
        <button class="btn-cancel" id="btnImportCancel">Cancel</button>
        <button class="btn-save" id="btnImportApply">Import</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const connNameInput = document.getElementById('connName');
    const headerTitle = document.getElementById('headerTitle');
    const catalogConnInput = document.getElementById('catalogConn');
    const dataPathInput = document.getElementById('dataPath');
    const overrideSwitch = document.getElementById('overrideDataPath');
    const dbAliasInput = document.getElementById('dbAlias');
    const testBanner = document.getElementById('testBanner');
    const btnTest = document.getElementById('btnTest');
    const btnSave = document.getElementById('btnSave');
    const btnCancel = document.getElementById('btnCancel');
    const btnBack = document.getElementById('btnBack');
    const btnBrowseDataPath = document.getElementById('btnBrowseDataPath');
    const btnBrowseCatalog = document.getElementById('btnBrowseCatalog');
    const catalogTypeHint = document.getElementById('catalogTypeHint');
    const connLabelText = document.getElementById('connLabelText');

    // Advanced inputs
    const advHost = document.getElementById('advHost');
    const advPort = document.getElementById('advPort');
    const advDb = document.getElementById('advDb');
    const advUser = document.getElementById('advUser');
    const advPass = document.getElementById('advPass');

    // Title update on connection name change
    connNameInput.addEventListener('input', () => {
      headerTitle.textContent = 'Edit: ' + (connNameInput.value.trim() || 'lake');
    });

    // Accordion
    const accToggle = document.getElementById('accToggle');
    const accContent = document.getElementById('accContent');
    const accChevron = document.getElementById('accChevron');
    accToggle.addEventListener('click', () => {
      const isOpen = accContent.classList.toggle('open');
      accChevron.textContent = isOpen ? '▲' : '▼';
    });

    // Segmented buttons - Catalog Type
    let selectedCatalogType = '${isLocal ? 'local' : 'server'}';
    document.querySelectorAll('#catalogTypeSeg .segmented-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#catalogTypeSeg .segmented-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedCatalogType = btn.dataset.val;

        if (selectedCatalogType === 'local') {
          catalogTypeHint.textContent = 'Local DuckDB database file (.duckdb)';
          connLabelText.textContent = 'DuckDB Database Path';
          catalogConnInput.placeholder = 'C:\\path\\to\\my_lake.duckdb';
          btnBrowseCatalog.textContent = 'Browse File';
          accToggle.style.display = 'none';
          accContent.classList.remove('open');
        } else {
          catalogTypeHint.textContent = 'PostgreSQL catalog metadata backend (DuckLake metastore tables)';
          connLabelText.textContent = 'Catalog Connection';
          catalogConnInput.placeholder = 'postgres:host=localhost port=5439 dbname=ducklake_catalog user=postgres password=...';
          btnBrowseCatalog.textContent = 'Parameters';
          accToggle.style.display = 'flex';
        }
      });
    });

    // Import modal
    const importModal = document.getElementById('importModal');
    const btnOpenImport = document.getElementById('btnOpenImport');
    const btnImportCancel = document.getElementById('btnImportCancel');
    const btnImportApply = document.getElementById('btnImportApply');
    const importStringText = document.getElementById('importStringText');

    btnOpenImport.addEventListener('click', () => {
      importModal.classList.add('show');
      importStringText.value = catalogConnInput.value;
      importStringText.focus();
    });

    btnImportCancel.addEventListener('click', () => {
      importModal.classList.remove('show');
    });

    btnImportApply.addEventListener('click', () => {
      const val = importStringText.value.trim();
      if (val) {
        catalogConnInput.value = val;
        syncToAdvanced(val);
      }
      importModal.classList.remove('show');
    });

    function syncToAdvanced(str) {
      if (!str) return;
      if (str.startsWith('postgresql://') || str.startsWith('postgres://')) {
        try {
          const u = new URL(str);
          if (u.hostname) advHost.value = u.hostname;
          if (u.port) advPort.value = u.port;
          if (u.pathname) advDb.value = u.pathname.replace(/^\\//, '');
          if (u.username) advUser.value = decodeURIComponent(u.username);
          if (u.password) advPass.value = decodeURIComponent(u.password);
          return;
        } catch (_) {}
      }
      // key-value format
      const cleaned = str.replace(/^postgres:/, '').trim();
      const regex = /([a-zA-Z_]+)=([^\\s"']+|'[^']*'|"[^"]*")/g;
      let match;
      while ((match = regex.exec(cleaned)) !== null) {
        const k = match[1].toLowerCase();
        let v = match[2].replace(/^['"]|['"]$/g, '');
        if (k === 'host') advHost.value = v;
        else if (k === 'port') advPort.value = v;
        else if (k === 'dbname' || k === 'database') advDb.value = v;
        else if (k === 'user' || k === 'username') advUser.value = v;
        else if (k === 'password') advPass.value = v;
      }
    }

    // Bidirectional sync: when parameters change, update catalog connection input
    function syncFromAdvanced() {
      if (selectedCatalogType !== 'server') return;
      const h = advHost.value.trim() || 'localhost';
      const p = advPort.value.trim() || '5439';
      const db = advDb.value.trim() || 'ducklake_catalog';
      const u = advUser.value.trim() || 'postgres';
      const pass = advPass.value;
      catalogConnInput.value = 'postgres:host=' + h + ' port=' + p + ' dbname=' + db + ' user=' + u + ' password=' + pass;
    }

    [advHost, advPort, advDb, advUser, advPass].forEach(input => {
      input.addEventListener('input', syncFromAdvanced);
    });

    catalogConnInput.addEventListener('change', () => {
      syncToAdvanced(catalogConnInput.value.trim());
    });

    function getFormData() {
      return {
        connectionName: connNameInput.value.trim() || 'lake',
        catalogType: selectedCatalogType,
        catalogConnection: catalogConnInput.value.trim(),
        dataPath: dataPathInput.value.trim(),
        overrideDataPath: overrideSwitch.checked,
        databaseAlias: dbAliasInput.value.trim() || 'lake',
        host: advHost.value.trim(),
        port: advPort.value.trim(),
        database: advDb.value.trim(),
        user: advUser.value.trim(),
        password: advPass.value
      };
    }

    // Browse buttons
    btnBrowseDataPath.addEventListener('click', () => {
      vscode.postMessage({ command: 'browseDataPath' });
    });

    btnBrowseCatalog.addEventListener('click', () => {
      if (selectedCatalogType === 'local') {
        vscode.postMessage({ command: 'browseCatalog' });
      } else {
        // Toggle accordion to edit connection details
        const isOpen = accContent.classList.toggle('open');
        accChevron.textContent = isOpen ? '▲' : '▼';
      }
    });

    // Test button
    btnTest.addEventListener('click', () => {
      btnTest.disabled = true;
      btnTest.innerHTML = '<span>⏳</span> Testing...';
      
      // Explicitly show testing banner
      testBanner.style.display = 'block';
      testBanner.className = 'test-banner info';
      testBanner.innerHTML = '<span>⏳</span> Connecting and verifying catalog...';

      vscode.postMessage({
        command: 'test',
        data: getFormData()
      });
    });

    // Copy Python Code button
    const btnCopyPython = document.getElementById('btnCopyPython');
    if (btnCopyPython) {
      btnCopyPython.addEventListener('click', () => {
        vscode.postMessage({
          command: 'copyPythonCode',
          data: getFormData()
        });
      });
    }

    // Open config file button
    const btnOpenConfig = document.getElementById('btnOpenConfig');
    if (btnOpenConfig) {
      btnOpenConfig.addEventListener('click', () => {
        vscode.postMessage({ command: 'openConfigFile' });
      });
    }

    // Save button
    btnSave.addEventListener('click', () => {
      vscode.postMessage({
        command: 'save',
        data: getFormData()
      });
    });

    // Cancel buttons
    btnCancel.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });
    btnBack.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });

    // Message handler from Extension Host
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command === 'testResult') {
        btnTest.disabled = false;
        btnTest.innerHTML = '<span>⚡</span> Test';

        testBanner.style.display = 'block';
        testBanner.className = 'test-banner ' + (msg.success ? 'success' : 'error');
        testBanner.innerHTML = (msg.success ? '<strong>✅ Connection Successful!</strong><br>' : '<strong>❌ Connection Failed!</strong><br>') + msg.message;
        testBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (msg.command === 'setDataPath') {
        dataPathInput.value = msg.path;
      } else if (msg.command === 'setCatalogConnection') {
        catalogConnInput.value = msg.path;
      }
    });
  </script>
</body>
</html>
    `;
  }
}
