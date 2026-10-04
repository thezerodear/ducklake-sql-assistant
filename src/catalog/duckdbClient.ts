import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { TableMetadata, ColumnMetadata } from './types';

export class DuckDBLocalClient {
  private static findDuckDBExecutable(): string | null {
    // 1. Check Winget package path
    const wingetDuckDB = path.join(
      process.env.LOCALAPPDATA || '',
      'Microsoft/WinGet/Packages/DuckDB.cli_Microsoft.Winget.Source_8wekyb3d8bbwe/duckdb.exe'
    );
    if (fs.existsSync(wingetDuckDB)) {
      return wingetDuckDB;
    }

    return null;
  }

  public static async fetchCatalog(databasePath: string): Promise<TableMetadata[]> {
    if (!fs.existsSync(databasePath)) {
      throw new Error(`DuckDB database file not found at: ${databasePath}`);
    }

    const tablesQuery = `
      SELECT table_schema, table_name, table_type 
      FROM information_schema.tables 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY table_schema, table_name;
    `;

    const columnsQuery = `
      SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default 
      FROM information_schema.columns 
      WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
      ORDER BY table_schema, table_name, ordinal_position;
    `;

    let tablesJson = '';
    let columnsJson = '';

    // Method 1: Try duckdb CLI executable if available
    const duckdbExe = this.findDuckDBExecutable() || 'duckdb';
    try {
      [tablesJson, columnsJson] = await Promise.all([
        this.runDuckDBQuery(duckdbExe, databasePath, tablesQuery),
        this.runDuckDBQuery(duckdbExe, databasePath, columnsQuery)
      ]);
    } catch {
      // Method 2: Fallback to Python 3.12+ with duckdb package (ideal for corporate environments without duckdb.exe)
      [tablesJson, columnsJson] = await Promise.all([
        this.runPythonDuckDBQuery(databasePath, tablesQuery),
        this.runPythonDuckDBQuery(databasePath, columnsQuery)
      ]);
    }

    const tablesRows = JSON.parse(tablesJson || '[]');
    const columnsRows = JSON.parse(columnsJson || '[]');

    const columnsByTable = new Map<string, ColumnMetadata[]>();
    for (const row of columnsRows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      if (!columnsByTable.has(tableKey)) {
        columnsByTable.set(tableKey, []);
      }
      columnsByTable.get(tableKey)!.push({
        name: row.column_name,
        dataType: row.data_type,
        isNullable: row.is_nullable === 'YES',
        defaultValue: row.column_default ?? undefined
      });
    }

    const tables: TableMetadata[] = [];
    for (const row of tablesRows) {
      const tableKey = `${row.table_schema}.${row.table_name}`;
      tables.push({
        schema: row.table_schema,
        name: row.table_name,
        fullName: `${row.table_schema}.${row.table_name}`,
        type: row.table_type,
        columns: columnsByTable.get(tableKey) || []
      });
    }

    return tables;
  }

  private static runDuckDBQuery(exe: string, dbPath: string, sql: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(exe, [dbPath, '-json', sql], (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  private static runPythonDuckDBQuery(dbPath: string, sql: string): Promise<string> {
    const pythonScript = `
import duckdb, json, sys
try:
    con = duckdb.connect(sys.argv[1], read_only=True)
    df = con.sql(sys.argv[2]).df()
    print(df.to_json(orient='records'))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
    `.trim();

    return new Promise((resolve, reject) => {
      // Try python, py, or python3
      const candidates = ['python', 'py', 'python3'];
      let lastErr: Error | null = null;

      const tryNext = (idx: number) => {
        if (idx >= candidates.length) {
          reject(lastErr || new Error('Python 3.12+ with duckdb library not found'));
          return;
        }

        const pyExe = candidates[idx];
        execFile(pyExe, ['-c', pythonScript, dbPath, sql], (err, stdout, stderr) => {
          if (err) {
            lastErr = new Error(stderr || err.message);
            tryNext(idx + 1);
          } else {
            resolve(stdout.trim());
          }
        });
      };

      tryNext(0);
    });
  }
}
