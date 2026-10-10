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

    // Do not generate completions on blank lines or lines containing only whitespace up to the cursor
    const lineText = document.lineAt(position.line).text;
    const linePrefix = lineText.substring(0, position.character);
    if (linePrefix.trim().length === 0) {
      return undefined;
    }

    const analysis = SqlContextAnalyzer.analyze(sqlDetection.sqlPrefix, sqlDetection.fullSql);
    const items: vscode.CompletionItem[] = [];
    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_\u0E00-\u0E7F]+/);

    switch (analysis.contextType) {
      case SqlContextType.DOT_COLUMN: {
        if (analysis.dotQualifier) {
          const lowerQualifier = analysis.dotQualifier.toLowerCase();
          const cols = this.schemaManager.getColumnsForTable(analysis.dotQualifier);
          for (const col of cols) {
            items.push(this.createColumnCompletionItem(col, analysis.dotQualifier, '0_', wordRange));
          }

          // Suggest tables within this schema (e.g., "main." or "public.")
          const schemaTables = this.schemaManager.getTables().filter(
            tbl => tbl.schema.toLowerCase() === lowerQualifier
          );
          for (const tbl of schemaTables) {
            items.push(this.createTableCompletionItem(tbl, '0_', wordRange));
          }

          // Check if qualifier is 2-part db.schema (e.g. "lake.main.")
          if (lowerQualifier.includes('.')) {
            const [dbPart, schPart] = lowerQualifier.split('.');
            const dbTables = this.schemaManager.getTables(dbPart);
            if (dbTables.length > 0) {
              const matchedTables = dbTables.filter(t => (t.schema || 'main').toLowerCase() === schPart);
              for (const tbl of matchedTables) {
                items.push(this.createTableCompletionItem(tbl, '0_', wordRange));
              }
            }
          }

          // If qualifier matches any database alias or connectionName (e.g. "lake.", "sales.")
          const databases = this.schemaManager.getDatabases();
          for (const db of databases) {
            const alias = (db.databaseAlias || db.connectionName).toLowerCase();
            const conn = db.connectionName.toLowerCase();
            if (lowerQualifier === alias || lowerQualifier === conn) {
              // Suggest schemas in this database
              const schemas = new Set(db.tables.map(t => t.schema || 'main'));
              for (const sch of schemas) {
                const schItem = new vscode.CompletionItem(sch, vscode.CompletionItemKind.Module);
                schItem.detail = `Schema (${db.databaseAlias || db.connectionName})`;
                schItem.sortText = `0_${sch}`;
                if (wordRange) schItem.range = wordRange;
                items.push(schItem);
              }
              // Suggest tables in this database
              for (const tbl of db.tables) {
                items.push(this.createTableCompletionItem(tbl, '1_', wordRange));
              }
            }
          }
        }
        break;
      }

      case SqlContextType.TABLE: {
        // Suggest database aliases
        const databases = this.schemaManager.getDatabases();
        for (const db of databases) {
          const alias = db.databaseAlias || db.connectionName;
          const dbItem = new vscode.CompletionItem(alias, vscode.CompletionItemKind.Module);
          dbItem.detail = `Database (${db.catalogType === 'local' ? 'Local DuckDB' : 'DuckLake Metastore'})`;
          dbItem.sortText = `0_${alias}`;
          if (wordRange) dbItem.range = wordRange;
          items.push(dbItem);
        }

        const tables = this.schemaManager.getTables();
        for (const tbl of tables) {
          items.push(this.createTableCompletionItem(tbl, '1_', wordRange));
        }
        if (config.suggestDuckDBFunctions) {
          items.push(...this.getDuckDBTableFunctions('2_', wordRange));
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
    const dbSuffix = table.databaseAlias ? ` • ${table.databaseAlias}` : '';
    item.detail = `${isView ? 'DuckLake / Postgres View' : 'DuckLake Table'} (${table.schema}${dbSuffix})`;
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

  public getSqlKeywords(sortPrefix: string, range?: vscode.Range): vscode.CompletionItem[] {
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

  public getDuckDBTableFunctions(sortPrefix: string, range?: vscode.Range): vscode.CompletionItem[] {
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

  public getDuckDBColumnFunctions(sortPrefix: string, range?: vscode.Range): vscode.CompletionItem[] {
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
      // ─── DuckDB Window & Analytical Functions ─────────────────────────
      {
        name: 'row_number()',
        snippet: 'row_number()',
        detail: 'DuckDB Window: Row Number',
        doc: 'Assigns a unique, sequential integer to each row within a window partition, starting at 1.'
      },
      {
        name: 'rank()',
        snippet: 'rank()',
        detail: 'DuckDB Window: Rank with Gaps',
        doc: 'Returns the rank of the current row with gaps; ties share the same rank, leaving gaps in subsequent ranks.'
      },
      {
        name: 'dense_rank()',
        snippet: 'dense_rank()',
        detail: 'DuckDB Window: Dense Rank (No Gaps)',
        doc: 'Returns the rank of the current row without gaps; consecutive groups always receive consecutive rank numbers.'
      },
      {
        name: 'percent_rank()',
        snippet: 'percent_rank()',
        detail: 'DuckDB Window: Relative Rank Percentile',
        doc: 'Calculates the relative rank of the current row: (rank() - 1) / (total partition rows - 1).'
      },
      {
        name: 'cume_dist()',
        snippet: 'cume_dist()',
        detail: 'DuckDB Window: Cumulative Distribution',
        doc: 'Calculates the cumulative distribution of a value within a window partition.'
      },
      {
        name: 'ntile()',
        snippet: 'ntile(${1:num_buckets})',
        detail: 'DuckDB Window: Ntile Buckets',
        doc: 'Divides rows in partition into num_buckets as equally as possible and returns bucket number from 1 to num_buckets.'
      },
      {
        name: 'lag()',
        snippet: 'lag(${1:col})',
        detail: 'DuckDB Window: Lag Previous Row',
        doc: 'Accesses data from a preceding row at a specified offset without needing a self-join.'
      },
      {
        name: 'lead()',
        snippet: 'lead(${1:col})',
        detail: 'DuckDB Window: Lead Subsequent Row',
        doc: 'Accesses data from a following row at a specified offset without needing a self-join.'
      },
      {
        name: 'first_value()',
        snippet: 'first_value(${1:col})',
        detail: 'DuckDB Window: First Value in Frame',
        doc: 'Returns the value evaluated at the first row of the window frame.'
      },
      {
        name: 'last_value()',
        snippet: 'last_value(${1:col})',
        detail: 'DuckDB Window: Last Value in Frame',
        doc: 'Returns the value evaluated at the last row of the window frame.'
      },
      {
        name: 'nth_value()',
        snippet: 'nth_value(${1:col}, ${2:1})',
        detail: 'DuckDB Window: Nth Value in Frame',
        doc: 'Returns the value evaluated at the nth row of the window frame (1-based index).'
      },
      {
        name: 'OVER (PARTITION BY ...)',
        snippet: 'OVER (PARTITION BY ${1:col} ORDER BY ${2:col})',
        detail: 'DuckDB Window Clause',
        doc: 'Defines window partitioning and ordering specification for window functions.'
      },
      {
        name: 'PARTITION BY',
        snippet: 'PARTITION BY ${1:column}',
        detail: 'DuckDB Window Partitioning',
        doc: 'Divides the result set into partitions to which the window function is independently applied.'
      },
      {
        name: 'QUALIFY',
        snippet: 'QUALIFY ${1:row_number() OVER (PARTITION BY ${2:id} ORDER BY ${3:date} DESC)} = 1',
        detail: 'DuckDB Window Filter Clause',
        doc: 'Filters rows based on the result of a window function directly, without needing a subquery or CTE.'
      },

      // ─── DuckDB List & Array Functions (https://duckdb.org/docs/sql/functions) ────
      {
        name: 'list()',
        snippet: 'list(${1:column})',
        detail: 'DuckDB List Aggregation',
        doc: 'Aggregates column values into a DuckDB LIST (array).'
      },
      {
        name: 'list_extract()',
        snippet: 'list_extract(${1:list_col}, ${2:1})',
        detail: 'DuckDB List: Extract by Index',
        doc: 'Extracts element at 1-based index from list. Equivalent to list[index].'
      },
      {
        name: 'list_element()',
        snippet: 'list_element(${1:list_col}, ${2:1})',
        detail: 'DuckDB List: Element by Index',
        doc: 'Extracts the element at 1-based index from a list.'
      },
      {
        name: 'list_append()',
        snippet: 'list_append(${1:list_col}, ${2:element})',
        detail: 'DuckDB List: Append',
        doc: 'Appends an element to the end of a list.'
      },
      {
        name: 'list_prepend()',
        snippet: 'list_prepend(${1:element}, ${2:list_col})',
        detail: 'DuckDB List: Prepend',
        doc: 'Prepends an element to the start of a list.'
      },
      {
        name: 'list_concat()',
        snippet: 'list_concat(${1:list1}, ${2:list2})',
        detail: 'DuckDB List: Concatenate Lists',
        doc: 'Concatenates two lists into a single list.'
      },
      {
        name: 'list_contains()',
        snippet: 'list_contains(${1:list_col}, ${2:element})',
        detail: 'DuckDB List: Contains Element',
        doc: 'Returns true if the list contains the given element.'
      },
      {
        name: 'list_position()',
        snippet: 'list_position(${1:list_col}, ${2:element})',
        detail: 'DuckDB List: Position of Element',
        doc: 'Returns 1-based index of element in list, or NULL if not found.'
      },
      {
        name: 'list_slice()',
        snippet: 'list_slice(${1:list_col}, ${2:1}, ${3:3})',
        detail: 'DuckDB List: Slice Sublist',
        doc: 'Extracts a slice of a list from begin to end index.'
      },
      {
        name: 'list_sort()',
        snippet: 'list_sort(${1:list_col})',
        detail: 'DuckDB List: Sort Elements',
        doc: 'Sorts elements of a list in ascending order.'
      },
      {
        name: 'list_reverse()',
        snippet: 'list_reverse(${1:list_col})',
        detail: 'DuckDB List: Reverse Order',
        doc: 'Reverses the order of elements in a list.'
      },
      {
        name: 'list_distinct()',
        snippet: 'list_distinct(${1:list_col})',
        detail: 'DuckDB List: Deduplicate Elements',
        doc: 'Removes duplicate elements from a list.'
      },
      {
        name: 'list_unique()',
        snippet: 'list_unique(${1:list_col})',
        detail: 'DuckDB List: Count Unique Elements',
        doc: 'Returns count of unique non-null elements in a list.'
      },
      {
        name: 'list_transform()',
        snippet: 'list_transform(${1:list_col}, ${2:x} -> ${3:x * 2})',
        detail: 'DuckDB List: Lambda Transform (Map)',
        doc: 'Transforms each element in list using a lambda function expression.'
      },
      {
        name: 'list_filter()',
        snippet: 'list_filter(${1:list_col}, ${2:x} -> ${3:x IS NOT NULL})',
        detail: 'DuckDB List: Lambda Filter',
        doc: 'Filters elements in list based on a boolean lambda condition.'
      },
      {
        name: 'list_reduce()',
        snippet: 'list_reduce(${1:list_col}, (${2:s, x}) -> ${3:s + x})',
        detail: 'DuckDB List: Lambda Reduce',
        doc: 'Reduces list elements to a single scalar value using an accumulator lambda.'
      },
      {
        name: 'list_aggregate()',
        snippet: "list_aggregate(${1:list_col}, '${2:sum}')",
        detail: 'DuckDB List: Aggregate List Elements',
        doc: 'Executes an aggregate function (e.g. sum, min, max, avg, string_agg) on list elements.'
      },
      {
        name: 'flatten()',
        snippet: 'flatten(${1:list_of_lists})',
        detail: 'DuckDB List: Flatten Nested Lists',
        doc: 'Flattens a list of lists into a single 1D list.'
      },
      {
        name: 'generate_series()',
        snippet: 'generate_series(${1:1}, ${2:10})',
        detail: 'DuckDB Series Generator',
        doc: 'Generates a table/list of sequential values from start to stop.'
      },
      {
        name: 'range()',
        snippet: 'range(${1:0}, ${2:10})',
        detail: 'DuckDB Range Generator',
        doc: 'Generates sequential values from start up to stop.'
      },
      {
        name: 'string_agg()',
        snippet: "string_agg(${1:column}, '${2:, '})",
        detail: 'DuckDB String Aggregation',
        doc: 'Concatenates strings into a single string separated by delimiter.'
      },
      {
        name: 'array_agg()',
        snippet: 'array_agg(${1:column})',
        detail: 'DuckDB Array Aggregation',
        doc: 'Aggregates values into an array/list.'
      },

      // ─── DuckDB Aggregation & Utility Functions ─────────────────────────
      { name: 'count(*)', snippet: 'count(*)', detail: 'Aggregate function' },
      { name: 'sum', snippet: 'sum(${1:column})', detail: 'Aggregate function' },
      { name: 'avg', snippet: 'avg(${1:column})', detail: 'Aggregate function' },
      { name: 'min', snippet: 'min(${1:column})', detail: 'Aggregate function' },
      { name: 'max', snippet: 'max(${1:column})', detail: 'Aggregate function' },
      { name: 'coalesce', snippet: 'coalesce(${1:val1}, ${2:val2})', detail: 'Return first non-null' },
      { name: 'date_trunc', snippet: "date_trunc('${1:day}', ${2:timestamp_col})", detail: 'Truncate timestamp to interval' },
      { name: 'strftime', snippet: "strftime(${1:timestamp_col}, '${2:%Y-%m-%d}')", detail: 'Format timestamp as string' },
      { name: 'unnest', snippet: 'unnest(${1:array_col})', detail: 'Unnest array/list into rows' },
      { name: 'struct_pack', snippet: 'struct_pack(${1:key := val})', detail: 'Create struct' },
      { name: 'quantile_cont', snippet: 'quantile_cont(${1:col}, ${2:0.5})', detail: 'Continuous quantile/percentile' }
    ];

    return functions.map(fn => {
      const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
      item.insertText = new vscode.SnippetString(fn.snippet);
      item.detail = fn.detail;
      if ((fn as any).doc) {
        item.documentation = new vscode.MarkdownString((fn as any).doc);
      }
      item.sortText = `${sortPrefix}${fn.name}`;
      if (range) {
        item.range = range;
      }
      return item;
    });
  }
}
