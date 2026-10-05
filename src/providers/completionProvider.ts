import * as vscode from 'vscode';
import { SchemaManager } from '../catalog/schemaManager';
import { SqlDetector } from '../parser/sqlDetector';
import { SqlContextAnalyzer, SqlContextType } from '../parser/sqlContext';
import { TableMetadata, ColumnMetadata } from '../catalog/types';

export class DuckLakeCompletionProvider implements vscode.CompletionItemProvider {
  private schemaManager: SchemaManager;

  constructor(schemaManager: SchemaManager) {
    this.schemaManager = schemaManager;
  }

  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    const config = this.schemaManager.readConfig();
    const sqlDetection = SqlDetector.detect(document, position, config.enableSmartHeuristic);

    if (!sqlDetection || !sqlDetection.isSql) {
      return undefined;
    }

    const analysis = SqlContextAnalyzer.analyze(sqlDetection.sqlPrefix, sqlDetection.fullSql);
    const items: vscode.CompletionItem[] = [];
    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_]+/);

    switch (analysis.contextType) {
      case SqlContextType.DOT_COLUMN: {
        if (analysis.dotQualifier) {
          const cols = this.schemaManager.getColumnsForTable(analysis.dotQualifier);
          for (const col of cols) {
            items.push(this.createColumnCompletionItem(col, analysis.dotQualifier, '0_', wordRange));
          }
        }
        break;
      }

      case SqlContextType.TABLE: {
        const tables = this.schemaManager.getTables();
        for (const tbl of tables) {
          items.push(this.createTableCompletionItem(tbl, '0_', wordRange));
        }
        if (config.suggestDuckDBFunctions) {
          items.push(...this.getDuckDBTableFunctions('1_', wordRange));
        }
        break;
      }

      case SqlContextType.COLUMN: {
        const addedCols = new Set<string>();
        if (analysis.referencedTables.length > 0) {
          for (const tblName of analysis.referencedTables) {
            const cols = this.schemaManager.getColumnsForTable(tblName);
            for (const col of cols) {
              const key = `${tblName}.${col.name}`;
              if (!addedCols.has(key)) {
                addedCols.add(key);
                items.push(this.createColumnCompletionItem(col, tblName, '0_', wordRange));
              }
            }
          }
        } else {
          const allCols = this.schemaManager.getAllColumns();
          for (const { column, table } of allCols) {
            const key = `${table.name}.${column.name}`;
            if (!addedCols.has(key)) {
              addedCols.add(key);
              items.push(this.createColumnCompletionItem(column, table.name, '1_', wordRange));
            }
          }
        }

        if (config.suggestDuckDBFunctions) {
          items.push(...this.getDuckDBColumnFunctions('2_', wordRange));
        }
        break;
      }

      case SqlContextType.GENERAL:
      default: {
        items.push(...this.getSqlKeywords('0_', wordRange));

        const tables = this.schemaManager.getTables();
        for (const tbl of tables) {
          items.push(this.createTableCompletionItem(tbl, '1_', wordRange));
        }

        if (config.suggestDuckDBFunctions) {
          items.push(...this.getDuckDBColumnFunctions('2_', wordRange));
          items.push(...this.getDuckDBTableFunctions('2_', wordRange));
        }
        break;
      }
    }

    return items;
  }

  private createTableCompletionItem(table: TableMetadata, sortPrefix: string, range?: vscode.Range): vscode.CompletionItem {
    const isView = (table.type || '').toUpperCase().includes('VIEW');
    const item = new vscode.CompletionItem(table.name, isView ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Class);
    item.detail = `${isView ? 'DuckLake / Postgres View' : 'DuckLake Table'} (${table.schema})`;
    item.sortText = `${sortPrefix}${table.name}`;
    if (range) {
      item.range = range;
    }

    const md = new vscode.MarkdownString();
    const icon = isView ? '👁️' : '🦆';
    md.appendMarkdown(`### ${icon} \`${table.fullName}\`\n\n`);
    md.appendMarkdown(`**Type:** ${table.type}  \n`);
    if (table.comment) {
      md.appendMarkdown(`**Description:** ${table.comment}  \n\n`);
    }

    md.appendMarkdown(`| Column | Type | Nullable |\n| :--- | :--- | :--- |\n`);
    for (const col of table.columns) {
      md.appendMarkdown(`| \`${col.name}\` | \`${col.dataType}\` | ${col.isNullable ? 'YES' : 'NO'} |\n`);
    }

    item.documentation = md;
    return item;
  }

  private createColumnCompletionItem(col: ColumnMetadata, tableName: string, sortPrefix: string, range?: vscode.Range): vscode.CompletionItem {
    const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
    item.detail = `${col.dataType} — ${tableName}`;
    item.sortText = `${sortPrefix}${col.name}`;
    if (range) {
      item.range = range;
    }

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`Column: **\`${tableName}.${col.name}\`**\n\n`);
    md.appendMarkdown(`- **Type:** \`${col.dataType}\`\n`);
    md.appendMarkdown(`- **Nullable:** \`${col.isNullable ? 'YES' : 'NO'}\`\n`);
    if (col.defaultValue) {
      md.appendMarkdown(`- **Default:** \`${col.defaultValue}\`\n`);
    }
    if (col.comment) {
      md.appendMarkdown(`- **Description:** ${col.comment}\n`);
    }

    item.documentation = md;
    return item;
  }

  private getSqlKeywords(sortPrefix: string, range?: vscode.Range): vscode.CompletionItem[] {
    const keywords = [
      'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN',
      'FULL JOIN', 'CROSS JOIN', 'ASOF JOIN', 'POSITIONAL JOIN', 'ON', 'AS',
      'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'WITH', 'UNION ALL',
      'UNION', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'QUALIFY', 'WINDOW', 'OVER',
      'PARTITION BY', 'DISTINCT', 'PIVOT', 'UNPIVOT', 'SAMPLE', 'COLUMNS',
      'EXCLUDE', 'REPLACE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN',
      'LIKE', 'ILIKE', 'IS NULL', 'IS NOT NULL', 'DESC', 'ASC', 'ATTACH',
      'DETACH', 'USE', 'PRAGMA'
    ];

    return keywords.map(kw => {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.sortText = `${sortPrefix}${kw}`;
      if (range) {
        item.range = range;
      }
      return item;
    });
  }

  private getDuckDBTableFunctions(sortPrefix: string, range?: vscode.Range): vscode.CompletionItem[] {
    const functions = [
      {
        name: 'read_parquet',
        snippet: "read_parquet('${1:path/to/*.parquet}')",
        detail: 'DuckDB read_parquet reader',
        doc: 'Reads one or multiple Parquet files directly from local disk, S3, MinIO, or HTTP.'
      },
      {
        name: 'read_csv',
        snippet: "read_csv('${1:path/to/*.csv}', header=true, auto_detect=true)",
        detail: 'DuckDB read_csv reader',
        doc: 'Fast multi-threaded CSV reader with schema inference.'
      },
      {
        name: 'read_json',
        snippet: "read_json('${1:path/to/*.json}')",
        detail: 'DuckDB read_json reader',
        doc: 'Reads NDJSON or JSON files with automatic schema detection.'
      },
      {
        name: 'duckdb_tables()',
        snippet: 'duckdb_tables()',
        detail: 'Catalog Inspection',
        doc: 'Returns all tables present in the DuckDB session and attached catalogs.'
      },
      {
        name: 'duckdb_columns()',
        snippet: 'duckdb_columns()',
        detail: 'Catalog Inspection',
        doc: 'Returns all columns and their types present in the DuckDB session.'
      }
    ];

    return functions.map(fn => {
      const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
      item.insertText = new vscode.SnippetString(fn.snippet);
      item.detail = fn.detail;
      item.documentation = new vscode.MarkdownString(fn.doc);
      item.sortText = `${sortPrefix}${fn.name}`;
      if (range) {
        item.range = range;
      }
      return item;
    });
  }

  private getDuckDBColumnFunctions(sortPrefix: string, range?: vscode.Range): vscode.CompletionItem[] {
    const functions = [
      {
        name: 'COLUMNS(*)',
        snippet: 'COLUMNS(*)',
        detail: 'DuckDB Dynamic Column Selection',
        doc: 'Selects all columns dynamically, allowing expressions like MIN(COLUMNS(*)) or COLUMNS(*) + 1.'
      },
      {
        name: "COLUMNS('regex')",
        snippet: "COLUMNS('${1:regex_pattern}')",
        detail: 'DuckDB Regex Column Selection',
        doc: "Selects columns matching a regex pattern, e.g. COLUMNS('^lake_.*') or COLUMNS('.*_id$')."
      },
      {
        name: 'COLUMNS(lambda)',
        snippet: 'COLUMNS(${1:c} -> ${1:c} ${2:LIKE \'%_id\'})',
        detail: 'DuckDB Lambda Column Selection',
        doc: 'Selects columns matching a lambda predicate condition.'
      },
      {
        name: 'COLUMNS(* EXCLUDE)',
        snippet: 'COLUMNS(* EXCLUDE (${1:column_name}))',
        detail: 'DuckDB Star Expression with EXCLUDE',
        doc: 'Selects all columns except the specified excluded columns.'
      },
      {
        name: 'COLUMNS(* REPLACE)',
        snippet: 'COLUMNS(* REPLACE (${1:expression} AS ${2:column_name}))',
        detail: 'DuckDB Star Expression with REPLACE',
        doc: 'Selects all columns while replacing specific column expressions.'
      },
      {
        name: 'EXCLUDE',
        snippet: 'EXCLUDE (${1:column_name})',
        detail: 'DuckDB Star Modifier',
        doc: 'Excludes specific column(s) from * or COLUMNS(*).'
      },
      {
        name: 'REPLACE',
        snippet: 'REPLACE (${1:expression} AS ${2:column_name})',
        detail: 'DuckDB Star Modifier',
        doc: 'Replaces specific column(s) within * or COLUMNS(*).'
      },
      { name: 'count(*)', snippet: 'count(*)', detail: 'Aggregate function' },
      { name: 'sum', snippet: 'sum(${1:column})', detail: 'Aggregate function' },
      { name: 'avg', snippet: 'avg(${1:column})', detail: 'Aggregate function' },
      { name: 'min', snippet: 'min(${1:column})', detail: 'Aggregate function' },
      { name: 'max', snippet: 'max(${1:column})', detail: 'Aggregate function' },
      { name: 'coalesce', snippet: 'coalesce(${1:val1}, ${2:val2})', detail: 'Return first non-null' },
      { name: 'date_trunc', snippet: "date_trunc('${1:day}', ${2:timestamp_col})", detail: 'Truncate timestamp to interval' },
      { name: 'strftime', snippet: "strftime(${1:timestamp_col}, '${2:%Y-%m-%d}')", detail: 'Format timestamp as string' },
      { name: 'unnest', snippet: 'unnest(${1:array_col})', detail: 'Unnest array/list into rows' },
      { name: 'list_transform', snippet: 'list_transform(${1:list}, ${2:x -> x * 2})', detail: 'Transform list elements with lambda' },
      { name: 'struct_pack', snippet: 'struct_pack(${1:key := val})', detail: 'Create struct' },
      { name: 'quantile_cont', snippet: 'quantile_cont(${1:col}, ${2:0.5})', detail: 'Continuous quantile/percentile' }
    ];

    return functions.map(fn => {
      const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
      item.insertText = new vscode.SnippetString(fn.snippet);
      item.detail = fn.detail;
      item.sortText = `${sortPrefix}${fn.name}`;
      if (range) {
        item.range = range;
      }
      return item;
    });
  }
}
