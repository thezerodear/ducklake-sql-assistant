import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SchemaManager } from './catalog/schemaManager';
import { DuckLakeCompletionProvider } from './providers/completionProvider';
import { DuckLakeHoverProvider } from './providers/hoverProvider';
import { DuckLakeStatusBar } from './ui/statusBar';
import { DuckLakeTreeDataProvider, CatalogTreeItem } from './ui/treeDataProvider';
import { DuckLakeConnectionWebview } from './ui/connectionWebview';
import { ConfigStorage } from './catalog/configStorage';
import { execFile } from 'child_process';
import { toggleCommentCommand } from './commands/commentCommand';

// Registered completion trigger characters: delimiters and alphanumeric typing (excluding newline and space)
export const TRIGGER_CHARACTERS = [
  '.', ',', '(', '"', "'", '`', '_',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
];

export function activate(context: vscode.ExtensionContext) {
  console.log('DuckLake SQL Assistant is activating...');

  ConfigStorage.init(context.globalStorageUri, context);

  const schemaManager = new SchemaManager();
  const statusBar = new DuckLakeStatusBar(schemaManager);
  const treeDataProvider = new DuckLakeTreeDataProvider(schemaManager);

  // Register Sidebar TreeView Explorer
  const treeView = vscode.window.registerTreeDataProvider(
    'ducklakeCatalogView',
    treeDataProvider
  );

  // Document selectors supporting Python files, Jupyter notebooks, and interactive windows
  const pythonSelectors: vscode.DocumentSelector = [
    { language: 'python' },
    { scheme: 'file', language: 'python' },
    { scheme: 'vscode-notebook-cell', language: 'python' },
    { notebookType: 'jupyter-notebook', language: 'python' },
    { scheme: 'untitled', language: 'python' }
  ];

  // Register Autocomplete Provider
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    pythonSelectors,
    new DuckLakeCompletionProvider(schemaManager),
    ...TRIGGER_CHARACTERS
  );

  // Register Hover Provider for Table & Column Schema inspection
  const hoverProvider = vscode.languages.registerHoverProvider(
    pythonSelectors,
    new DuckLakeHoverProvider(schemaManager)
  );

  // Commands
  const refreshCommand = vscode.commands.registerCommand('ducklake.refreshCatalog', async () => {
    await schemaManager.refreshCatalog(false);
    treeDataProvider.refresh();
  });

  const testConnectionCommand = vscode.commands.registerCommand('ducklake.testConnection', async () => {
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'DuckLake: Testing Connection...',
        cancellable: false
      },
      async () => {
        const result = await schemaManager.testConnection();
        if (result.success) {
          vscode.window.showInformationMessage(result.message);
        } else {
          vscode.window.showErrorMessage(result.message);
        }
      }
    );
  });

  const openSettingsCommand = vscode.commands.registerCommand('ducklake.openSettings', () => {
    DuckLakeConnectionWebview.show(context.extensionUri, schemaManager);
  });

  const openModalCommand = vscode.commands.registerCommand('ducklake.openConnectionModal', () => {
    DuckLakeConnectionWebview.show(context.extensionUri, schemaManager);
  });

  const openConfigFileCommand = vscode.commands.registerCommand('ducklake.openConfigFile', async () => {
    const filePath = ConfigStorage.getStorageFilePath();
    if (!fs.existsSync(filePath)) {
      const currentConfig = schemaManager.readConfig();
      await ConfigStorage.saveConfig(currentConfig);
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc);
  });

  const copyConnectCodeCommand = vscode.commands.registerCommand('ducklake.copyConnectCode', async () => {
    const config = schemaManager.readConfig();
    const isLocal = config.catalogType === 'local';
    const alias = config.databaseAlias || config.connectionName || 'lake';

    let dataPathClause = '';
    if (config.dataPath && config.overrideDataPath) {
      const cleanPath = config.dataPath.replace(/\\/g, '/');
      dataPathClause = ` (DATA_PATH '${cleanPath}')`;
    }

    let attachTarget = '';
    let extensionsLoad = '';

    if (isLocal) {
      const cleanDb = (config.duckdbDatabasePath || 'ducklake.db').replace(/^(?:ducklake:)+/i, '').replace(/\\/g, '/');
      attachTarget = `ducklake:${cleanDb}`;
      extensionsLoad = 'con.execute("INSTALL ducklake; LOAD ducklake;")';
    } else {
      let raw = config.connectionString?.trim() || '';
      if (!raw) {
        raw = `host=${config.host} port=${config.port} dbname=${config.database} user=${config.user} password=${config.password}`;
      }
      let cleaned = raw.replace(/^(?:ducklake:)+/i, '').trim();
      if (!cleaned.startsWith('postgresql://') && !cleaned.startsWith('postgres://')) {
        cleaned = cleaned.replace(/^(?:postgres:)+/i, '').trim();
      }
      // DuckDB expects UTF-8 internally; strip client_encoding parameter from DuckDB ATTACH string
      cleaned = cleaned.replace(/\s*client_encoding=[^\s]+/gi, '').replace(/[?&]client_encoding=[^&#\s]*/gi, '').trim();
      attachTarget = `ducklake:postgres:${cleaned}`;
      extensionsLoad = `con.execute("INSTALL ducklake; INSTALL postgres;")\ncon.execute("LOAD ducklake; LOAD postgres;")`;
    }

    const snippet = `import duckdb

# 1. Connect DuckDB
con = duckdb.connect()

# 2. Install & load extensions
${extensionsLoad}

# 3. Attach DuckLake Catalog
con.execute("""
    ATTACH '${attachTarget}' 
    AS ${alias}${dataPathClause};
""")

# 4. Use database
con.execute("USE ${alias};")
con.sql("SHOW TABLES;").show()
`;

    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage('DuckLake: Python connection code copied to clipboard!');
  });

  const showMenuCommand = vscode.commands.registerCommand('ducklake.showMenu', () => {
    statusBar.showQuickPickMenu();
  });

  const insertSelectCommand = vscode.commands.registerCommand(
    'ducklake.insertSelectQuery',
    (item: CatalogTreeItem) => {
      const tableName = item?.metadata?.table?.fullName || item?.metadata?.table?.name || item?.label;
      if (!tableName) return;

      const editor = vscode.window.activeTextEditor;
      if (editor) {
        editor.insertSnippet(
          new vscode.SnippetString(`con.sql("""\n    SELECT * FROM ${tableName} LIMIT 10;\n""").show()\n`)
        );
      } else {
        vscode.window.showInformationMessage(`DuckLake: Generated snippet for "${tableName}". Open a Python or Notebook editor to insert queries.`);
      }
    }
  );

  const insertColumnNameCommand = vscode.commands.registerCommand(
    'ducklake.insertColumnName',
    (columnName: string) => {
      if (!columnName) return;
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        editor.insertSnippet(new vscode.SnippetString(columnName));
      } else {
        vscode.env.clipboard.writeText(columnName);
        vscode.window.showInformationMessage(`Copied column "${columnName}" to clipboard.`);
      }
    }
  );

  const copyNameCommand = vscode.commands.registerCommand(
    'ducklake.copyName',
    (item: CatalogTreeItem) => {
      const name = item?.label;
      if (name) {
        vscode.env.clipboard.writeText(name);
        vscode.window.showInformationMessage(`Copied "${name}" to clipboard.`);
      }
    }
  );

  const createMockDbCommand = vscode.commands.registerCommand('ducklake.createMockDatabase', async () => {
    const folders = vscode.workspace.workspaceFolders;
    const targetDir = folders && folders.length > 0 ? folders[0].uri.fsPath : context.extensionPath;
    const dbPath = path.join(targetDir, 'mock_ducklake.duckdb');

    const sqlInit = `
      CREATE TABLE IF NOT EXISTS lake_users (
        user_id BIGINT PRIMARY KEY,
        username VARCHAR,
        email VARCHAR,
        role VARCHAR,
        status VARCHAR,
        created_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS lake_events (
        event_id UUID,
        tenant_id VARCHAR,
        event_type VARCHAR,
        payload JSON,
        created_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS lake_orders (
        order_id BIGINT,
        user_id BIGINT,
        amount DECIMAL(10, 2),
        order_status VARCHAR,
        ordered_at TIMESTAMP
      );
      INSERT INTO lake_users VALUES 
        (1, 'alice', 'alice@ducklake.io', 'admin', 'ACTIVE', now()),
        (2, 'bob', 'bob@ducklake.io', 'analyst', 'ACTIVE', now())
      ON CONFLICT DO NOTHING;
    `;

    execFile('duckdb', [dbPath, sqlInit], async (err) => {
      if (err) {
        vscode.window.showErrorMessage(`Failed to create mock DuckDB: ${err.message}`);
      } else {
        await schemaManager.refreshCatalog(false);
        treeDataProvider.refresh();
        vscode.window.showInformationMessage(`Created & connected mock DuckDB: ${dbPath}`);
      }
    });
  });

  // Watch for configuration changes
  const configWatcher = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration('ducklake.autocomplete.acceptSuggestionOnEnter')) {
      const config = vscode.workspace.getConfiguration('ducklake');
      const val = config.get<string>('autocomplete.acceptSuggestionOnEnter');
      if (val) {
        try {
          const pyConfig = vscode.workspace.getConfiguration('[python]');
          if (pyConfig.get('editor.acceptSuggestionOnEnter') !== val) {
            await pyConfig.update('editor.acceptSuggestionOnEnter', val, vscode.ConfigurationTarget.Global);
          }
        } catch {
          // Ignore cleanly if unable to update global configuration
        }
      }
    } else if (e.affectsConfiguration('ducklake')) {
      await schemaManager.refreshCatalog(true);
      treeDataProvider.refresh();
    }
  });

  const storageWatcher = ConfigStorage.onDidChangeConfig(async () => {
    await schemaManager.refreshCatalog(true);
    treeDataProvider.refresh();
  });

  const addDatabaseCommand = vscode.commands.registerCommand('ducklake.addDatabase', () => {
    DuckLakeConnectionWebview.show(context.extensionUri, schemaManager, undefined, true);
  });

  const setActiveDatabaseCommand = vscode.commands.registerCommand(
    'ducklake.setActiveDatabase',
    async (item?: CatalogTreeItem) => {
      const dbName = item?.metadata?.database || item?.label;
      if (!dbName) return;
      await schemaManager.setActiveDatabase(dbName);
      treeDataProvider.refresh();
      vscode.window.showInformationMessage(`DuckLake: Active database switched to "${dbName}".`);
    }
  );

  const refreshDatabaseCommand = vscode.commands.registerCommand(
    'ducklake.refreshDatabase',
    async (item?: CatalogTreeItem) => {
      const dbName = item?.metadata?.database || item?.label;
      await schemaManager.refreshCatalog(false, dbName);
      treeDataProvider.refresh();
    }
  );

  const editDatabaseCommand = vscode.commands.registerCommand(
    'ducklake.editDatabase',
    (item?: CatalogTreeItem) => {
      const dbName = item?.metadata?.database || item?.label;
      DuckLakeConnectionWebview.show(context.extensionUri, schemaManager, dbName, false);
    }
  );

  const deleteDatabaseCommand = vscode.commands.registerCommand(
    'ducklake.deleteDatabase',
    async (item?: CatalogTreeItem) => {
      const dbName = item?.metadata?.database || item?.label;
      if (!dbName) return;
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete database connection "${dbName}"?`,
        { modal: true },
        'Delete',
        'Cancel'
      );
      if (confirm === 'Delete') {
        const ok = await ConfigStorage.removeConnection(dbName);
        if (ok) {
          await schemaManager.refreshCatalog(false);
          treeDataProvider.refresh();
          vscode.window.showInformationMessage(`DuckLake: Database "${dbName}" deleted.`);
        }
      }
    }
  );

  const copyDatabaseAttachCodeCommand = vscode.commands.registerCommand(
    'ducklake.copyDatabaseAttachCode',
    async (item?: CatalogTreeItem) => {
      const dbName = item?.metadata?.database || item?.label;
      const config = dbName ? schemaManager.readConfig(dbName) : schemaManager.readConfig();
      const isLocal = config.catalogType === 'local';
      const alias = config.databaseAlias || config.connectionName || 'lake';

      let snippet = '';
      if (isLocal) {
        const dbPath = (config.duckdbDatabasePath || 'ducklake.db').replace(/^(?:ducklake:)+/i, '').replace(/\\/g, '/');
        snippet = `ATTACH 'ducklake:${dbPath}' AS ${alias};\nUSE ${alias};\nSHOW TABLES;`;
      } else {
        let raw = config.connectionString?.trim() || '';
        if (!raw) {
          raw = `host=${config.host} port=${config.port} dbname=${config.database} user=${config.user} password=${config.password}`;
        }
        let cleaned = raw.replace(/^(?:ducklake:)+/i, '').trim();
        if (!cleaned.startsWith('postgresql://') && !cleaned.startsWith('postgres://')) {
          cleaned = cleaned.replace(/^(?:postgres:)+/i, '').trim();
        }
        let dataPathClause = '';
        if (config.dataPath && config.overrideDataPath) {
          const cleanPath = config.dataPath.replace(/\\/g, '/');
          dataPathClause = ` (DATA_PATH '${cleanPath}')`;
        }
        snippet = `ATTACH 'ducklake:postgres:${cleaned}' AS ${alias}${dataPathClause};\nUSE ${alias};\nSHOW TABLES;`;
      }
      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage(`DuckLake: ATTACH SQL code for "${alias}" copied to clipboard!`);
    }
  );

  const toggleCommentCommandRegistration = vscode.commands.registerCommand(
    'ducklake.toggleComment',
    async (editor?: vscode.TextEditor) => {
      return await toggleCommentCommand(editor);
    }
  );

  context.subscriptions.push(
    schemaManager,
    statusBar,
    treeView,
    completionProvider,
    hoverProvider,
    toggleCommentCommandRegistration,
    refreshCommand,
    testConnectionCommand,
    openSettingsCommand,
    openModalCommand,
    openConfigFileCommand,
    copyConnectCodeCommand,
    showMenuCommand,
    insertSelectCommand,
    insertColumnNameCommand,
    copyNameCommand,
    createMockDbCommand,
    addDatabaseCommand,
    setActiveDatabaseCommand,
    refreshDatabaseCommand,
    editDatabaseCommand,
    deleteDatabaseCommand,
    copyDatabaseAttachCodeCommand,
    configWatcher,
    storageWatcher
  );

  // Initial catalog sync
  schemaManager.refreshCatalog(true).then(() => {
    treeDataProvider.refresh();
  }).catch(() => {});
}

export function deactivate() {
  console.log('DuckLake SQL Assistant is deactivated.');
}
