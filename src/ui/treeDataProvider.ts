import * as vscode from 'vscode';
import { SchemaManager } from '../catalog/schemaManager';
import { TableMetadata, ColumnMetadata } from '../catalog/types';

export type NodeType =
  | 'database'
  | 'schemasGroup'
  | 'schema'
  | 'tablesGroup'
  | 'table'
  | 'column'
  | 'viewsGroup'
  | 'functionsGroup';

export class CatalogTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly nodeType: NodeType,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly metadata?: {
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
        this.description = '0B, Default, Type: ducklake';
        break;

      case 'schemasGroup':
        this.iconPath = new vscode.ThemeIcon('folder');
        this.description = this.metadata?.extra || '1';
        break;

      case 'schema':
        this.iconPath = new vscode.ThemeIcon('folder-opened', new vscode.ThemeColor('charts.yellow'));
        this.description = 'Default';
        break;

      case 'tablesGroup':
        this.iconPath = new vscode.ThemeIcon('table');
        this.description = this.metadata?.extra || '';
        break;

      case 'table':
        this.iconPath = new vscode.ThemeIcon('table', new vscode.ThemeColor('charts.green'));
        if (this.metadata?.table?.rowCount != null) {
          this.description = `${this.metadata.table.rowCount} rows`;
        }
        this.tooltip = `Table: ${this.metadata?.table?.fullName}\nType: ${this.metadata?.table?.type}\nColumns: ${this.metadata?.table?.columns.length}`;
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

      case 'viewsGroup':
        this.iconPath = new vscode.ThemeIcon('eye');
        this.description = '0';
        break;

      case 'functionsGroup':
        this.iconPath = new vscode.ThemeIcon('symbol-function');
        break;
    }
  }
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

  public async getChildren(element?: CatalogTreeItem): Promise<CatalogTreeItem[]> {
    const tables = this.schemaManager.getTables();

    // Group tables by schema
    const schemasMap = new Map<string, TableMetadata[]>();
    for (const t of tables) {
      const s = t.schema || 'main';
      if (!schemasMap.has(s)) {
        schemasMap.set(s, []);
      }
      schemasMap.get(s)!.push(t);
    }

    if (schemasMap.size === 0) {
      schemasMap.set('main', []);
    }

    // 1. Root Level -> Database node "lake"
    if (!element) {
      return [
        new CatalogTreeItem('lake', 'database', vscode.TreeItemCollapsibleState.Expanded)
      ];
    }

    // 2. Under Database -> Schemas folder
    if (element.nodeType === 'database') {
      return [
        new CatalogTreeItem(
          'Schemas',
          'schemasGroup',
          vscode.TreeItemCollapsibleState.Expanded,
          { extra: `${schemasMap.size}` }
        )
      ];
    }

    // 3. Under Schemas folder -> Schema items (e.g. "main")
    if (element.nodeType === 'schemasGroup') {
      const schemaItems: CatalogTreeItem[] = [];
      for (const [schemaName] of schemasMap) {
        schemaItems.push(
          new CatalogTreeItem(
            schemaName,
            'schema',
            vscode.TreeItemCollapsibleState.Expanded,
            { schema: schemaName }
          )
        );
      }
      return schemaItems;
    }

    // 4. Under Schema -> Tables folder, Views folder, Functions folder
    if (element.nodeType === 'schema') {
      const schemaName = element.metadata?.schema || 'main';
      const schemaTables = schemasMap.get(schemaName) || [];
      return [
        new CatalogTreeItem(
          'Tables',
          'tablesGroup',
          vscode.TreeItemCollapsibleState.Expanded,
          { schema: schemaName, extra: `${schemaTables.length}` }
        ),
        new CatalogTreeItem('Views', 'viewsGroup', vscode.TreeItemCollapsibleState.Collapsed),
        new CatalogTreeItem('Functions', 'functionsGroup', vscode.TreeItemCollapsibleState.Collapsed)
      ];
    }

    // 5. Under Tables folder -> Table items (e.g. "customers", "orders", "products")
    if (element.nodeType === 'tablesGroup') {
      const schemaName = element.metadata?.schema || 'main';
      const schemaTables = schemasMap.get(schemaName) || [];
      return schemaTables.map(
        (t) =>
          new CatalogTreeItem(
            t.name,
            'table',
            vscode.TreeItemCollapsibleState.Collapsed,
            { table: t, schema: schemaName }
          )
      );
    }

    // 6. Under Table -> Columns list
    if (element.nodeType === 'table' && element.metadata?.table) {
      const cols = element.metadata.table.columns;
      return cols.map(
        (c) =>
          new CatalogTreeItem(
            c.name,
            'column',
            vscode.TreeItemCollapsibleState.None,
            { column: c, table: element.metadata?.table }
          )
      );
    }

    return [];
  }
}
