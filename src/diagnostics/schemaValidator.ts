import * as vscode from 'vscode';
import { SchemaManager } from '../catalog/schemaManager';
import { SqlDiagnosticItem, SqlToken, SqlTokenizer } from './sqlValidator';

const TABLE_FUNCTIONS = new Set([
  'read_parquet', 'read_csv', 'read_csv_auto', 'read_json', 'read_json_auto',
  'parquet_scan', 'csv_scan', 'range', 'generate_series', 'glob', 'repeat',
  'unnest', 'flatten', 'duckdb_tables', 'duckdb_views', 'duckdb_columns',
  'delta_scan', 'iceberg_scan', 'query_table', 'scan_csv', 'scan_parquet'
]);

const NON_ALIAS_KEYWORDS = new Set([
  'WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'NATURAL',
  'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'WINDOW', 'QUALIFY', 'UNION',
  'INTERSECT', 'EXCEPT', 'USING', 'SET', 'VALUES', 'SELECT', 'WITH', 'AS', 'AND', 'OR'
]);

export interface ExtractedTableRef {
  rawName: string;
  cleanName: string;
  start: number;
  end: number;
}

export interface CatalogLookupAdapter {
  findTable: (nameOrAlias: string) => { name: string; columns: { name: string }[] } | undefined;
  isConnected: boolean;
  hasTables: boolean;
}

export class SchemaValidator {
  public static validateSchema(
    document: vscode.TextDocument,
    sqlBlock: { text: string; startOffset: number; endOffset: number },
    schemaManager: SchemaManager
  ): SqlDiagnosticItem[] {
    if (!schemaManager) {
      return [];
    }
    const state = schemaManager.getState();
    const adapter: CatalogLookupAdapter = {
      isConnected: state.status === 'connected',
      hasTables: schemaManager.getTables().length > 0,
      findTable: (name) => schemaManager.findTable(name)
    };
    return this.validateWithAdapter(document, sqlBlock, adapter);
  }

  public static validateSchemaWithTables(
    document: vscode.TextDocument,
    sqlBlock: { text: string; startOffset: number; endOffset: number },
    catalogTables: Map<string, { columns: string[] }>,
    isCatalogConnected: boolean
  ): SqlDiagnosticItem[] {
    const adapter: CatalogLookupAdapter = {
      isConnected: isCatalogConnected,
      hasTables: catalogTables.size > 0,
      findTable: (name) => {
        const clean = name.toLowerCase().trim().replace(/["`]/g, '');
        if (catalogTables.has(clean)) {
          const entry = catalogTables.get(clean)!;
          return { name: clean, columns: entry.columns.map(c => ({ name: c })) };
        }
        if (clean.includes('.')) {
          const simple = clean.split('.').pop()!;
          if (catalogTables.has(simple)) {
            const entry = catalogTables.get(simple)!;
            return { name: simple, columns: entry.columns.map(c => ({ name: c })) };
          }
        }
        for (const [key, val] of catalogTables.entries()) {
          const kClean = key.toLowerCase().replace(/["`]/g, '');
          if (kClean === clean || kClean.endsWith('.' + clean) || clean.endsWith('.' + kClean)) {
            return { name: key, columns: val.columns.map(c => ({ name: c })) };
          }
        }
        return undefined;
      }
    };
    return this.validateWithAdapter(document, sqlBlock, adapter);
  }

  public static validateWithAdapter(
    document: vscode.TextDocument,
    sqlBlock: { text: string; startOffset: number; endOffset: number },
    adapter: CatalogLookupAdapter
  ): SqlDiagnosticItem[] {
    const diagnostics: SqlDiagnosticItem[] = [];

    // 1. Check catalog status: if disconnected or empty, suppress all schema warnings
    if (!adapter.isConnected || !adapter.hasTables) {
      return diagnostics;
    }

    const { tokens } = SqlTokenizer.tokenize(sqlBlock.text);
    const nonTrivia = tokens.filter(t => t.type !== 'WHITESPACE' && t.type !== 'COMMENT');

    // 2. Extract CTEs: WITH [RECURSIVE] cte AS (...)
    const cteNames = this.extractCteNames(nonTrivia);

    // 3. Extract Tables, Subqueries, and Aliases from FROM and JOIN
    const { tables, aliasMap, tableTokenIndices } = this.extractTablesAndAliases(nonTrivia, cteNames);

    // 4. Validate Table Existence
    for (const tableRef of tables) {
      const lower = tableRef.cleanName.toLowerCase();

      // Skip if it's a CTE
      if (cteNames.has(lower)) {
        continue;
      }

      // Skip if it's a table function
      if (TABLE_FUNCTIONS.has(lower) || lower.startsWith('read_') || lower.startsWith('parquet_') || lower.startsWith('csv_')) {
        continue;
      }

      // Check table in catalog
      const found = adapter.findTable(tableRef.cleanName);
      if (!found) {
        const startPos = document.positionAt(sqlBlock.startOffset + tableRef.start);
        const endPos = document.positionAt(sqlBlock.startOffset + tableRef.end);
        diagnostics.push({
          range: new vscode.Range(startPos, endPos),
          message: `Table '${tableRef.rawName}' does not exist in DuckLake catalog`,
          severity: vscode.DiagnosticSeverity.Warning
        });
      }
    }

    // 5. Validate Qualified Columns (qualifier.column)
    const qualifiedCols = this.extractQualifiedColumns(nonTrivia, tableTokenIndices);
    for (const qCol of qualifiedCols) {
      const qualifierLower = qCol.qualifier.toLowerCase().replace(/["`]/g, '');
      const columnLower = qCol.column.toLowerCase().replace(/["`]/g, '');

      // Wildcard exemption: e.g. u.*
      if (columnLower === '*') {
        continue;
      }

      // Skip if qualifier is a CTE name
      if (cteNames.has(qualifierLower)) {
        continue;
      }

      // Resolve qualifier to table name if it's an alias
      const resolvedTable = aliasMap.get(qualifierLower) || qualifierLower;

      // Skip if resolved table is a CTE
      if (cteNames.has(resolvedTable.toLowerCase())) {
        continue;
      }

      // Check if table exists in catalog
      const tableMeta = adapter.findTable(resolvedTable);
      if (tableMeta) {
        // Table exists, check if column exists on it
        const hasColumn = tableMeta.columns.some(
          c => c.name.toLowerCase() === columnLower
        );
        if (!hasColumn) {
          const startPos = document.positionAt(sqlBlock.startOffset + qCol.colStart);
          const endPos = document.positionAt(sqlBlock.startOffset + qCol.colEnd);
          diagnostics.push({
            range: new vscode.Range(startPos, endPos),
            message: `Column '${qCol.column}' does not exist on table '${tableMeta.name}'`,
            severity: vscode.DiagnosticSeverity.Warning
          });
        }
      }
    }

    return diagnostics;
  }

  private static extractCteNames(tokens: SqlToken[]): Set<string> {
    const cteNames = new Set<string>();
    const len = tokens.length;

    for (let i = 0; i < len; i++) {
      if (tokens[i].type === 'KEYWORD' && tokens[i].text.toUpperCase() === 'WITH') {
        let idx = i + 1;
        if (idx < len && tokens[idx].type === 'KEYWORD' && tokens[idx].text.toUpperCase() === 'RECURSIVE') {
          idx++;
        }

        while (idx < len) {
          // Look for CTE identifier
          const nameToken = tokens[idx];
          if (nameToken.type !== 'IDENTIFIER' && nameToken.type !== 'QUOTED_IDENT') {
            break;
          }

          const cteName = nameToken.text.toLowerCase().replace(/["`]/g, '');
          cteNames.add(cteName);
          idx++;

          // Optional column list: (col1, col2)
          if (idx < len && tokens[idx].type === 'LPAREN') {
            let parenDepth = 1;
            idx++;
            while (idx < len && parenDepth > 0) {
              if (tokens[idx].type === 'LPAREN') parenDepth++;
              else if (tokens[idx].type === 'RPAREN') parenDepth--;
              idx++;
            }
          }

          // Expect AS
          if (idx < len && tokens[idx].type === 'KEYWORD' && tokens[idx].text.toUpperCase() === 'AS') {
            idx++;
          } else {
            break;
          }

          // Expect subquery ( ... )
          if (idx < len && tokens[idx].type === 'LPAREN') {
            let parenDepth = 1;
            idx++;
            while (idx < len && parenDepth > 0) {
              if (tokens[idx].type === 'LPAREN') parenDepth++;
              else if (tokens[idx].type === 'RPAREN') parenDepth--;
              idx++;
            }
          } else {
            break;
          }

          // Check if there is another CTE after comma
          if (idx < len && tokens[idx].type === 'COMMA') {
            idx++;
            // If next token is SELECT, WITH ended
            if (idx < len && tokens[idx].type === 'KEYWORD' && tokens[idx].text.toUpperCase() === 'SELECT') {
              break;
            }
          } else {
            break;
          }
        }
      }
    }

    return cteNames;
  }

  private static extractTablesAndAliases(
    tokens: SqlToken[],
    cteNames: Set<string>
  ): {
    tables: ExtractedTableRef[];
    aliasMap: Map<string, string>;
    tableTokenIndices: Set<number>;
  } {
    const tables: ExtractedTableRef[] = [];
    const aliasMap = new Map<string, string>();
    const tableTokenIndices = new Set<number>();
    const len = tokens.length;

    let i = 0;
    while (i < len) {
      const token = tokens[i];
      const kw = token.type === 'KEYWORD' ? token.text.toUpperCase() : '';

      if (kw === 'FROM' || kw === 'JOIN') {
        i++;
        while (i < len) {
          const next = tokens[i];

          // 1. Subquery: FROM (SELECT ...) [AS] alias
          if (next.type === 'LPAREN') {
            let depth = 1;
            i++;
            while (i < len && depth > 0) {
              if (tokens[i].type === 'LPAREN') depth++;
              else if (tokens[i].type === 'RPAREN') depth--;
              i++;
            }
            // Optional alias after subquery
            if (i < len) {
              if (tokens[i].type === 'KEYWORD' && tokens[i].text.toUpperCase() === 'AS') {
                i++;
              }
              if (i < len && (tokens[i].type === 'IDENTIFIER' || tokens[i].type === 'QUOTED_IDENT')) {
                const subAlias = tokens[i].text.toLowerCase().replace(/["`]/g, '');
                aliasMap.set(subAlias, subAlias); // self-aliased subquery
                i++;
              }
            }
            break;
          }

          // 2. Table or Function Name
          if (next.type === 'IDENTIFIER' || next.type === 'QUOTED_IDENT') {
            // Read potentially dotted table name (e.g. lake.main.users or main.users)
            let rawTable = next.text;
            const startOffset = next.start;
            let endOffset = next.end;
            tableTokenIndices.add(i);

            let j = i + 1;
            while (j + 1 < len && tokens[j].type === 'DOT' && (tokens[j + 1].type === 'IDENTIFIER' || tokens[j + 1].type === 'QUOTED_IDENT')) {
              rawTable += '.' + tokens[j + 1].text;
              endOffset = tokens[j + 1].end;
              tableTokenIndices.add(j);
              tableTokenIndices.add(j + 1);
              j += 2;
            }
            i = j;

            // Check if it's a function call like read_parquet(...)
            if (i < len && tokens[i].type === 'LPAREN') {
              // Skip function argument list
              let depth = 1;
              i++;
              while (i < len && depth > 0) {
                if (tokens[i].type === 'LPAREN') depth++;
                else if (tokens[i].type === 'RPAREN') depth--;
                i++;
              }
              // Optional alias after table function
              if (i < len) {
                if (tokens[i].type === 'KEYWORD' && tokens[i].text.toUpperCase() === 'AS') {
                  i++;
                }
                if (i < len && (tokens[i].type === 'IDENTIFIER' || tokens[i].type === 'QUOTED_IDENT')) {
                  const funcAlias = tokens[i].text.toLowerCase().replace(/["`]/g, '');
                  aliasMap.set(funcAlias, rawTable);
                  i++;
                }
              }
              break;
            }

            const cleanTable = rawTable.replace(/["`]/g, '');
            tables.push({
              rawName: rawTable,
              cleanName: cleanTable,
              start: startOffset,
              end: endOffset
            });

            // Map self name to aliasMap
            aliasMap.set(cleanTable.toLowerCase(), cleanTable);
            if (cleanTable.includes('.')) {
              const simpleName = cleanTable.split('.').pop()!;
              aliasMap.set(simpleName.toLowerCase(), cleanTable);
            }

            // Check for optional alias: [AS] alias
            if (i < len) {
              if (tokens[i].type === 'KEYWORD' && tokens[i].text.toUpperCase() === 'AS') {
                i++;
              }
              if (i < len && (tokens[i].type === 'IDENTIFIER' || tokens[i].type === 'QUOTED_IDENT')) {
                const aliasCandidate = tokens[i].text.toUpperCase();
                if (!NON_ALIAS_KEYWORDS.has(aliasCandidate)) {
                  const cleanAlias = tokens[i].text.toLowerCase().replace(/["`]/g, '');
                  aliasMap.set(cleanAlias, cleanTable);
                  i++;
                }
              }
            }

            // Check for comma join: FROM t1, t2
            if (i < len && tokens[i].type === 'COMMA') {
              i++;
              continue;
            }

            break;
          }

          break;
        }
      } else {
        i++;
      }
    }

    return { tables, aliasMap, tableTokenIndices };
  }

  private static extractQualifiedColumns(
    tokens: SqlToken[],
    tableTokenIndices: Set<number>
  ): {
    qualifier: string;
    column: string;
    colStart: number;
    colEnd: number;
  }[] {
    const result: { qualifier: string; column: string; colStart: number; colEnd: number }[] = [];
    const len = tokens.length;

    for (let i = 0; i < len - 2; i++) {
      // If this token was part of a table name in FROM/JOIN, skip
      if (tableTokenIndices.has(i) || tableTokenIndices.has(i + 1) || tableTokenIndices.has(i + 2)) {
        continue;
      }

      const t1 = tokens[i];
      const t2 = tokens[i + 1];
      const t3 = tokens[i + 2];

      if (
        (t1.type === 'IDENTIFIER' || t1.type === 'QUOTED_IDENT') &&
        t2.type === 'DOT' &&
        (t3.type === 'IDENTIFIER' || t3.type === 'QUOTED_IDENT' || (t3.type === 'OPERATOR' && t3.text === '*'))
      ) {
        result.push({
          qualifier: t1.text,
          column: t3.text,
          colStart: t3.start,
          colEnd: t3.end
        });
      }
    }

    return result;
  }
}
