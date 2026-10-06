import * as vscode from 'vscode';
import { SchemaManager } from '../catalog/schemaManager';
import { TableMetadata, ColumnMetadata } from '../catalog/types';

export type NodeType =
  | 'database'
  | 'schemasGroup'
  | 'schema'
  | 'tablesGroup'
  | 'table'
  | 'viewsGroup'
  | 'view'
  | 'column'
  | 'functionsGroup';

export class CatalogTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly nodeType: NodeType,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly metadata?: {
      database?: string;
      schema?: string;
      table?: TableMetadata;
      column?: ColumnMetadata;
      extra?: string;
    }
  ) {
    super(label, collapsibleState);
    this.contextValue = nodeType;
    this.setupVisuals();
  }

  private setupVisuals(): void {
    switch (this.nodeType) {
      case 'database':
        this.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
        if (!this.description) {
          this.description = 'Type: ducklake';
        }
        break;

      case 'schemasGroup':
        this.iconPath = new vscode.ThemeIcon('folder');
        this.description = this.metadata?.extra || '1';
        break;

      case 'schema':
        this.iconPath = new vscode.ThemeIcon('folder-opened', new vscode.ThemeColor('charts.yellow'));
        this.description = '';
        break;

      case 'tablesGroup':
        this.iconPath = new vscode.ThemeIcon('table');
        this.description = this.metadata?.extra || '0';
        break;

      case 'viewsGroup':
        this.iconPath = new vscode.ThemeIcon('eye');
        this.description = this.metadata?.extra || '0';
        break;

      case 'table':
        this.iconPath = new vscode.ThemeIcon('table', new vscode.ThemeColor('charts.green'));
        if (this.metadata?.table?.rowCount != null) {
          this.description = `${this.metadata.table.rowCount} rows`;
        }
        this.tooltip = `Table: ${this.metadata?.table?.fullName}\nType: ${this.metadata?.table?.type}\nColumns: ${this.metadata?.table?.columns?.length ?? 0}`;
        break;

      case 'view':
        this.iconPath = new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.orange'));
        if (this.metadata?.table?.rowCount != null) {
          this.description = `${this.metadata.table.rowCount} rows`;
        } else {
          this.description = 'view';
        }
        this.tooltip = `View: ${this.metadata?.table?.fullName}\nType: VIEW\nColumns: ${this.metadata?.table?.columns?.length ?? 0}`;
        break;

      case 'column':
        this.iconPath = new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('charts.purple'));
        if (this.metadata?.column) {
          this.description = `${this.metadata.column.dataType}${this.metadata.column.isNullable ? '' : ' (not null)'}`;
          this.tooltip = `Column: ${this.metadata.column.name}\nType: ${this.metadata.column.dataType}\nNullable: ${this.metadata.column.isNullable ? 'YES' : 'NO'}`;
        }
        // Click column to insert its name into editor
        this.command = {
          command: 'ducklake.insertColumnName',
          title: 'Insert Column Name',
          arguments: [this.metadata?.column?.name]
        };
        break;

      case 'functionsGroup':
        this.iconPath = new vscode.ThemeIcon('symbol-function');
        break;
    }
  }
}

interface SchemaGroup {
  tables: TableMetadata[];
  views: TableMetadata[];
}

export class DuckLakeTreeDataProvider implements vscode.TreeDataProvider<CatalogTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<CatalogTreeItem | undefined | null | void> =
    new vscode.EventEmitter<CatalogTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CatalogTreeItem | undefined | null | void> =
    this._onDidChangeTreeData.event;

  constructor(private schemaManager: SchemaManager) {
    this.schemaManager.onDidChangeSchema(() => {
      this.refresh();
    });
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: CatalogTreeItem): vscode.TreeItem {
    return element;
  }

  private groupTablesBySchema(tables: TableMetadata[]): Map<string, SchemaGroup> {
    const schemasMap = new Map<string, SchemaGroup>();
    for (const item of tables) {
      const s = item.schema || 'main';
      if (!schemasMap.has(s)) {
        schemasMap.set(s, { tables: [], views: [] });
      }
      const isView = (item.type || '').toUpperCase().includes('VIEW');
      if (isView) {
        schemasMap.get(s)!.views.push(item);
      } else {
        schemasMap.get(s)!.tables.push(item);
      }
    }

    if (schemasMap.size === 0) {
      schemasMap.set('main', { tables: [], views: [] });
    }
    return schemasMap;
  }

  public async getChildren(element?: CatalogTreeItem): Promise<CatalogTreeItem[]> {
    const databases = this.schemaManager.getDatabases();
    const activeDbName = this.schemaManager.getActiveDatabaseName().toLowerCase();

    // 1. Root Level -> List of Databases
    if (!element) {
      if (databases.length === 0) {
        const config = this.schemaManager.readConfig();
        const dbAlias = config.databaseAlias || config.connectionName || 'lake';
        const defaultItem = new CatalogTreeItem(dbAlias, 'database', vscode.TreeItemCollapsibleState.Expanded, {
          database: config.connectionName || 'lake',
          extra: dbAlias
        });
        defaultItem.contextValue = 'databaseActive';
        defaultItem.description = 'Active • Type: ducklake';
        return [defaultItem];
      }

      return databases.map(db => {
        const isActive =
          db.connectionName.toLowerCase() === activeDbName ||
          db.databaseAlias.toLowerCase() === activeDbName;
        const label = db.databaseAlias || db.connectionName;
        const isExpanded = isActive || databases.length === 1;

        const item = new CatalogTreeItem(
          label,
          'database',
          isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
          {
            database: db.connectionName,
            extra: db.databaseAlias
          }
        );

        item.contextValue = isActive ? 'databaseActive' : 'database';
        const typeStr = db.catalogType === 'local' ? 'local DuckDB' : 'ducklake';

        if (db.status === 'error') {
          item.iconPath = new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.red'));
          item.description = `${isActive ? 'Active • ' : ''}${typeStr} (Error)`;
          item.tooltip = `Database: ${db.connectionName}\nAlias: ${db.databaseAlias}\nStatus: ERROR\nError: ${db.errorMessage || 'Connection failed'}`;
        } else {
          item.iconPath = new vscode.ThemeIcon('database', isActive ? new vscode.ThemeColor('charts.blue') : new vscode.ThemeColor('charts.green'));
          item.description = `${isActive ? 'Active • ' : ''}${typeStr} (${db.tables.length} tables)`;
          item.tooltip = `Database: ${db.connectionName}\nAlias: ${db.databaseAlias}\nStatus: ${db.status}\nTables: ${db.tables.length}`;
        }

        return item;
      });
    }

    // 2. Under Database -> Schemas folder
    if (element.nodeType === 'database') {
      const dbKey = element.metadata?.database;
      const dbTables = this.schemaManager.getTables(dbKey);
      const schemasMap = this.groupTablesBySchema(dbTables);

      return [
        new CatalogTreeItem(
          'Schemas',
          'schemasGroup',
          vscode.TreeItemCollapsibleState.Expanded,
          { database: dbKey, extra: `${schemasMap.size}` }
        )
      ];
    }

    // 3. Under Schemas folder -> Schema items (e.g. "main", "public", etc.)
    if (element.nodeType === 'schemasGroup') {
      const dbKey = element.metadata?.database;
      const dbTables = this.schemaManager.getTables(dbKey);
      const schemasMap = this.groupTablesBySchema(dbTables);
      const schemaItems: CatalogTreeItem[] = [];

      for (const [schemaName, group] of schemasMap) {
        const totalItems = group.tables.length + group.views.length;
        schemaItems.push(
          new CatalogTreeItem(
            schemaName,
            'schema',
            vscode.TreeItemCollapsibleState.Expanded,
            { database: dbKey, schema: schemaName, extra: `${totalItems}` }
          )
        );
      }
      return schemaItems;
    }

    // 4. Under Schema -> Tables folder, Views folder, Functions folder
    if (element.nodeType === 'schema') {
      const dbKey = element.metadata?.database;
      const schemaName = element.metadata?.schema || 'main';
      const dbTables = this.schemaManager.getTables(dbKey);
      const schemasMap = this.groupTablesBySchema(dbTables);
      const group = schemasMap.get(schemaName) || { tables: [], views: [] };

      return [
        new CatalogTreeItem(
          'Tables',
          'tablesGroup',
          group.tables.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
          { database: dbKey, schema: schemaName, extra: `${group.tables.length}` }
        ),
        new CatalogTreeItem(
          'Views',
          'viewsGroup',
          group.views.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
          { database: dbKey, schema: schemaName, extra: `${group.views.length}` }
        ),
        new CatalogTreeItem('Functions', 'functionsGroup', vscode.TreeItemCollapsibleState.Collapsed, {
          database: dbKey,
          schema: schemaName
        })
      ];
    }

    // 5. Under Tables folder -> Table items
    if (element.nodeType === 'tablesGroup') {
      const dbKey = element.metadata?.database;
      const schemaName = element.metadata?.schema || 'main';
      const dbTables = this.schemaManager.getTables(dbKey);
      const schemasMap = this.groupTablesBySchema(dbTables);
      const group = schemasMap.get(schemaName) || { tables: [], views: [] };

      return group.tables.map(
        (t) =>
          new CatalogTreeItem(
            t.name,
            'table',
            vscode.TreeItemCollapsibleState.Collapsed,
            { database: dbKey, table: t, schema: schemaName }
          )
      );
    }

    // 5b. Under Views folder -> View items
    if (element.nodeType === 'viewsGroup') {
      const dbKey = element.metadata?.database;
      const schemaName = element.metadata?.schema || 'main';
      const dbTables = this.schemaManager.getTables(dbKey);
      const schemasMap = this.groupTablesBySchema(dbTables);
      const group = schemasMap.get(schemaName) || { tables: [], views: [] };

      return group.views.map(
        (v) =>
          new CatalogTreeItem(
            v.name,
            'view',
            vscode.TreeItemCollapsibleState.Collapsed,
            { database: dbKey, table: v, schema: schemaName }
          )
      );
    }

    // 6. Under Table or View -> Columns list
    if ((element.nodeType === 'table' || element.nodeType === 'view') && element.metadata?.table) {
      const cols = element.metadata.table.columns || [];
      return cols.map(
        (c) =>
          new CatalogTreeItem(
            c.name,
            'column',
            vscode.TreeItemCollapsibleState.None,
            { database: element.metadata?.database, column: c, table: element.metadata?.table }
          )
      );
    }

    return [];
  }
}
