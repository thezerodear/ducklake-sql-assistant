import { Client, ClientConfig } from 'pg';
import { TableMetadata, ColumnMetadata, PostgresConfig } from './types';

// Patch pg-protocol's BufferReader to decode WIN874 / CP874 natively when requested
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BufferReader } = require('pg-protocol/dist/buffer-reader');
  if (BufferReader && !(BufferReader as any).__win874Patched) {
    (BufferReader as any).__win874Patched = true;
    const origString = BufferReader.prototype.string;
    const origCstring = BufferReader.prototype.cstring;
    const thaiDecoder = new TextDecoder('windows-874');

    BufferReader.prototype.string = function (length: number): string {
      const enc = (process.env.PGCLIENTENCODING || '').toUpperCase();
      if (enc === 'WIN874' || enc === 'TIS620' || enc === 'WINDOWS-874') {
        const slice = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        return thaiDecoder.decode(slice);
      }
      return origString.call(this, length);
    };

    BufferReader.prototype.cstring = function (): string {
      const enc = (process.env.PGCLIENTENCODING || '').toUpperCase();
      if (enc === 'WIN874' || enc === 'TIS620' || enc === 'WINDOWS-874') {
        const start = this.offset;
        let end = start;
        while (this.buffer[end++]) {}
        this.offset = end;
        const slice = this.buffer.subarray(start, end - 1);
        return thaiDecoder.decode(slice);
      }
      return origCstring.call(this);
    };
  }
} catch (_) {
  // ignore if pg-protocol internals are not accessible
}

export class PostgresCatalogClient {
  private config: PostgresConfig;

  constructor(config: PostgresConfig) {
    this.config = config;
  }

  public updateConfig(config: PostgresConfig): void {
    this.config = config;
  }

  public static parseConnString(str: string): {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
  } {
    if (!str || !str.trim()) return {};
    const trimmed = str.trim();
    if (trimmed.startsWith('postgresql://') || trimmed.startsWith('postgres://')) {
      try {
        const u = new URL(trimmed);
        return {
          host: u.hostname || undefined,
          port: u.port ? parseInt(u.port, 10) : undefined,
          database: u.pathname ? u.pathname.replace(/^\//, '') : undefined,
          user: u.username ? decodeURIComponent(u.username) : undefined,
          password: u.password ? decodeURIComponent(u.password) : undefined
        };
      } catch (_) {
        // ignore
      }
    }

    const cleaned = trimmed.replace(/^(?:ducklake:)?(?:postgres:)+/i, '').trim();
    const result: any = {};
    const regex = /([a-zA-Z_]+)=([^\s"']+|'[^']*'|"[^"]*")/g;
    let match;
    while ((match = regex.exec(cleaned)) !== null) {
      const key = match[1].toLowerCase();
      let val = match[2];
      if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
        val = val.slice(1, -1);
      }
      if (key === 'host') result.host = val;
      else if (key === 'port') result.port = parseInt(val, 10);
      else if (key === 'dbname' || key === 'database') result.database = val;
      else if (key === 'user' || key === 'username') result.user = val;
      else if (key === 'password') result.password = val;
    }
    return result;
  }

  private async configureEncoding(client: Client): Promise<string> {
    const desired = this.config.clientEncoding?.trim();
    if (desired && desired.toLowerCase() !== 'auto') {
      const safeDesired = desired.replace(/[^a-zA-Z0-9_-]/g, '');
      try {
        await client.query(`SET client_encoding = '${safeDesired}';`);
        return safeDesired;
      } catch (err) {
        console.warn(`DuckLake: Custom client_encoding '${safeDesired}' failed:`, err);
      }
    }

    // Auto strategy: Query the active client encoding directly without forcing UTF-8 conversion
    try {
      const res = await client.query('SHOW client_encoding;');
      const activeEnc = res.rows[0]?.client_encoding;
      if (activeEnc) {
        return activeEnc;
      }
    } catch (_) {
      // ignore
    }

    try {
      const res = await client.query('SHOW server_encoding;');
      return res.rows[0]?.server_encoding || 'WIN874';
    } catch (_) {
      return 'WIN874';
    }
  }

  private createClient(): Client {
    const enc = this.config.clientEncoding && this.config.clientEncoding.toLowerCase() !== 'auto'
      ? this.config.clientEncoding
      : 'WIN874';
    process.env.PGCLIENTENCODING = enc;
    const clientOptions = `-c client_encoding=${enc}`;

    const rawConnStr = this.config.connectionString?.trim();
    if (rawConnStr) {
      if (rawConnStr.startsWith('postgresql://') || rawConnStr.startsWith('postgres://')) {
        return new Client({
          connectionString: rawConnStr,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
          connectionTimeoutMillis: 5000,
          options: clientOptions
        });
      }

      // If user provided DuckDB / libpq style connection string e.g. postgres:host=...
      const parsed = PostgresCatalogClient.parseConnString(rawConnStr);
      if (parsed.host || parsed.database) {
        return new Client({
          host: parsed.host || this.config.host,
          port: parsed.port || this.config.port,
          database: parsed.database || this.config.database,
          user: parsed.user || this.config.user,
          password: parsed.password || this.config.password,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
          connectionTimeoutMillis: 5000,
          options: clientOptions
        });
      }

      return new Client({
        connectionString: rawConnStr,
        ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 5000,
        options: clientOptions
      });
    }

    const clientConfig: ClientConfig = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 5000,
      options: clientOptions
    };

    return new Client(clientConfig);
  }

  public async testConnection(): Promise<{ success: boolean; message: string; version?: string }> {
    const client = this.createClient();
    try {
      await client.connect();
      const usedEncoding = await this.configureEncoding(client);
      const res = await client.query('SELECT version();');

      // Check if DuckLake metastore is detected
      const ducklakeCheck = await client.query("SELECT to_regclass('public.ducklake_table') as has_ducklake;");
      const hasDuckLake = !!ducklakeCheck.rows[0]?.has_ducklake;

      let extra = '';
      if (hasDuckLake) {
        const countRes = await client.query("SELECT COUNT(*) FROM ducklake_table WHERE end_snapshot IS NULL;");
        const count = countRes.rows[0]?.count ?? 0;
        extra = ` (DuckLake Metastore detected: ${count} active lakehouse tables)`;
      }

      return {
        success: true,
        message: `Successfully connected to PostgreSQL (${usedEncoding})!${extra}`,
        version: res.rows[0]?.version
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Failed to connect to PostgreSQL: ${err.message || err}`
      };
    } finally {
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  }

  public async fetchCatalog(): Promise<TableMetadata[]> {
    const client = this.createClient();
    try {
      await client.connect();
      await this.configureEncoding(client);

      const tables: TableMetadata[] = [];
      const tablesMap = new Map<string, TableMetadata>();

      // Check if DuckLake metastore tables exist in PostgreSQL
      const ducklakeCheck = await client.query("SELECT to_regclass('public.ducklake_table') as has_ducklake;");
      const hasDuckLake = !!ducklakeCheck.rows[0]?.has_ducklake;

      if (hasDuckLake) {
        // 🦆 1. NATIVE DUCKLAKE METASTORE PARSING (TABLES)
        const tablesQuery = `
          SELECT 
            s.schema_name,
            t.table_name,
            'DUCKLAKE TABLE' AS table_type,
            'DuckLake table backed by local or S3 parquet storage' AS table_comment,
            ts.record_count,
            ts.file_size_bytes
          FROM ducklake_table t
          JOIN ducklake_schema s ON t.schema_id = s.schema_id
          LEFT JOIN ducklake_table_stats ts ON t.table_id = ts.table_id
          WHERE t.end_snapshot IS NULL
          ORDER BY s.schema_name, t.table_name;
        `;

        const columnsQuery = `
          SELECT 
            s.schema_name,
            t.table_name,
            c.column_name,
            c.column_type AS data_type,
            c.nulls_allowed AS is_nullable,
            c.default_value,
            'DuckLake column' AS column_comment
          FROM ducklake_column c
          JOIN ducklake_table t ON c.table_id = t.table_id
          JOIN ducklake_schema s ON t.schema_id = s.schema_id
          WHERE t.end_snapshot IS NULL AND c.end_snapshot IS NULL
          ORDER BY s.schema_name, t.table_name, CAST(COALESCE(c.column_order, 0) AS integer);
        `;

        const [tablesResult, columnsResult] = await Promise.all([
          client.query(tablesQuery),
          client.query(columnsQuery)
        ]);

        const columnsByTable = new Map<string, ColumnMetadata[]>();
        for (const row of columnsResult.rows) {
          const tableKey = `${row.schema_name}.${row.table_name}`;
          if (!columnsByTable.has(tableKey)) {
            columnsByTable.set(tableKey, []);
          }

          columnsByTable.get(tableKey)!.push({
            name: row.column_name,
            dataType: row.data_type,
            isNullable: row.is_nullable === true || row.is_nullable === 't',
            defaultValue: row.default_value ?? undefined,
            comment: row.column_comment ?? undefined
          });
        }

        for (const row of tablesResult.rows) {
          const tableKey = `${row.schema_name}.${row.table_name}`;
          const cols = columnsByTable.get(tableKey) || [];

          const tMeta: TableMetadata = {
            schema: row.schema_name,
            name: row.table_name,
            fullName: tableKey,
            type: row.table_type,
            columns: cols,
            comment: row.table_comment ?? undefined,
            rowCount: row.record_count != null ? parseInt(row.record_count, 10) : undefined,
            fileSizeBytes: row.file_size_bytes != null ? parseInt(row.file_size_bytes, 10) : undefined
          };
          tablesMap.set(tableKey, tMeta);
          tables.push(tMeta);
        }

        // 🦆 1b. DUCKLAKE METASTORE VIEWS (if ducklake_view table exists)
        try {
          const viewCheck = await client.query("SELECT to_regclass('public.ducklake_view') as has_view;");
          if (viewCheck.rows[0]?.has_view) {
            const viewsQuery = `
              SELECT 
                s.schema_name,
                v.view_name AS table_name,
                'VIEW' AS table_type,
                'DuckLake view' AS table_comment,
                v.sql AS view_definition
              FROM ducklake_view v
              JOIN ducklake_schema s ON v.schema_id = s.schema_id
              WHERE v.end_snapshot IS NULL
              ORDER BY s.schema_name, v.view_name;
            `;
            const viewsResult = await client.query(viewsQuery);
            for (const row of viewsResult.rows) {
              const tableKey = `${row.schema_name}.${row.table_name}`;
              if (!tablesMap.has(tableKey)) {
                const vMeta: TableMetadata = {
                  schema: row.schema_name,
                  name: row.table_name,
                  fullName: tableKey,
                  type: 'VIEW',
                  columns: [],
                  comment: row.table_comment ?? undefined,
                  viewDefinition: row.view_definition ?? undefined
                };
                tablesMap.set(tableKey, vMeta);
                tables.push(vMeta);
              }
            }
          }
        } catch {
          // ignore if ducklake_view table doesn't exist
        }
      }

      // 🐘 2. POSTGRESQL TABLES & VIEWS ACROSS ALL SCHEMAS (e.g. public, analytics, staging, etc.)
      try {
        const pgTablesQuery = `
          SELECT 
            t.table_schema,
            t.table_name,
            t.table_type,
            obj_description(pgc.oid, 'pg_class') as table_comment
          FROM information_schema.tables t
          LEFT JOIN pg_catalog.pg_class pgc 
            ON pgc.relname = t.table_name
            AND pgc.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = t.table_schema)
          WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            AND t.table_name NOT LIKE 'ducklake_%'
          ORDER BY t.table_schema, t.table_name;
        `;

        const pgColumnsQuery = `
          SELECT 
            c.table_schema,
            c.table_name,
            c.column_name,
            c.data_type,
            c.is_nullable,
            c.column_default,
            col_description(pgc.oid, c.ordinal_position) as column_comment
          FROM information_schema.columns c
          LEFT JOIN pg_catalog.pg_class pgc 
            ON pgc.relname = c.table_name
            AND pgc.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = c.table_schema)
          WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            AND c.table_name NOT LIKE 'ducklake_%'
          ORDER BY c.table_schema, c.table_name, c.ordinal_position;
        `;

        const [pgTablesRes, pgColumnsRes] = await Promise.all([
          client.query(pgTablesQuery),
          client.query(pgColumnsQuery)
        ]);

        const pgColsByTable = new Map<string, ColumnMetadata[]>();
        for (const row of pgColumnsRes.rows) {
          const key = `${row.table_schema}.${row.table_name}`;
          if (!pgColsByTable.has(key)) {
            pgColsByTable.set(key, []);
          }
          pgColsByTable.get(key)!.push({
            name: row.column_name,
            dataType: row.data_type,
            isNullable: row.is_nullable === 'YES',
            defaultValue: row.column_default ?? undefined,
            comment: row.column_comment ?? undefined
          });
        }

        for (const row of pgTablesRes.rows) {
          const key = `${row.table_schema}.${row.table_name}`;
          const isViewType = row.table_type === 'VIEW' || row.table_type === 'MATERIALIZED VIEW';
          const typeStr = isViewType ? 'VIEW' : (row.table_type || 'BASE TABLE');

          if (!tablesMap.has(key)) {
            const cols = pgColsByTable.get(key) || [];
            const meta: TableMetadata = {
              schema: row.table_schema,
              name: row.table_name,
              fullName: key,
              type: typeStr,
              columns: cols,
              comment: row.table_comment ?? undefined
            };
            tablesMap.set(key, meta);
            tables.push(meta);
          } else {
            // If already in map but missing columns, fill in from pg columns
            const existing = tablesMap.get(key)!;
            if (existing.columns.length === 0 && pgColsByTable.has(key)) {
              existing.columns = pgColsByTable.get(key)!;
            }
          }
        }
      } catch (pgErr) {
        console.error('Error fetching PostgreSQL tables/views:', pgErr);
      }

      return tables;
    } catch (err: any) {
      throw new Error(`Catalog query failed: ${err.message || err}`);
    } finally {
      try {
        await client.end();
      } catch {
        // ignore
      }
    }
  }

  public static getSampleCatalog(): TableMetadata[] {
    return [
      {
        schema: 'main',
        name: 'customers',
        fullName: 'main.customers',
        type: 'DUCKLAKE TABLE',
        comment: 'Customer directory',
        columns: [
          { name: 'customer_id', dataType: 'int32', isNullable: false },
          { name: 'name', dataType: 'varchar', isNullable: false },
          { name: 'email', dataType: 'varchar', isNullable: false },
          { name: 'city', dataType: 'varchar', isNullable: true },
          { name: 'signup_date', dataType: 'date', isNullable: true }
        ]
      },
      {
        schema: 'main',
        name: 'products',
        fullName: 'main.products',
        type: 'DUCKLAKE TABLE',
        comment: 'Product catalog',
        columns: [
          { name: 'product_id', dataType: 'int32', isNullable: false },
          { name: 'name', dataType: 'varchar', isNullable: false },
          { name: 'category', dataType: 'varchar', isNullable: true },
          { name: 'price', dataType: 'decimal(10,2)', isNullable: false },
          { name: 'stock_qty', dataType: 'int32', isNullable: false }
        ]
      },
      {
        schema: 'main',
        name: 'orders',
        fullName: 'main.orders',
        type: 'DUCKLAKE TABLE',
        comment: 'Customer orders',
        columns: [
          { name: 'order_id', dataType: 'int32', isNullable: false },
          { name: 'customer_id', dataType: 'int32', isNullable: false },
          { name: 'product_id', dataType: 'int32', isNullable: false },
          { name: 'quantity', dataType: 'int32', isNullable: false },
          { name: 'order_date', dataType: 'date', isNullable: false },
          { name: 'status', dataType: 'varchar', isNullable: false }
        ]
      },
      {
        schema: 'main',
        name: 'customer_order_summary',
        fullName: 'main.customer_order_summary',
        type: 'VIEW',
        comment: 'Aggregated order statistics by customer',
        columns: [
          { name: 'customer_id', dataType: 'int32', isNullable: false },
          { name: 'total_orders', dataType: 'int64', isNullable: true },
          { name: 'total_spent', dataType: 'decimal(12,2)', isNullable: true }
        ]
      }
    ];
  }
}
