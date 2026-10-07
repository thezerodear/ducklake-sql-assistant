import { Client, ClientConfig } from 'pg';
import { TextDecoder } from 'util';
import { TableMetadata, ColumnMetadata, PostgresConfig } from './types';

// Cache for TextDecoders across different charsets
const textDecoderCache = new Map<string, TextDecoder>();

function getDecoder(encoding: string): TextDecoder | null {
  const norm = (encoding || '').toUpperCase().trim();
  if (!norm || norm === 'UTF8' || norm === 'UTF-8' || norm === 'UNICODE') {
    return null; // UTF-8 is decoded natively by BufferReader / Buffer.toString('utf-8')
  }

  // Map PostgreSQL encoding names to WHATWG TextDecoder encoding names
  const encodingMap: Record<string, string> = {
    'WIN874': 'windows-874',
    'WINDOWS-874': 'windows-874',
    'CP874': 'windows-874',
    'TIS620': 'windows-874',
    'TIS-620': 'windows-874',
    'WIN1252': 'windows-1252',
    'WINDOWS-1252': 'windows-1252',
    'CP1252': 'windows-1252',
    'LATIN1': 'iso-8859-1',
    'ISO-8859-1': 'iso-8859-1',
    'WIN1251': 'windows-1251',
    'GBK': 'gbk',
    'GB18030': 'gb18030',
    'BIG5': 'big5',
    'SJIS': 'shift_jis',
    'SHIFT_JIS': 'shift_jis',
    'WIN932': 'shift_jis',
    'EUC_JP': 'euc-jp',
    'EUC_KR': 'euc-kr'
  };

  const whatwgName = encodingMap[norm] || norm.toLowerCase();
  if (textDecoderCache.has(whatwgName)) {
    return textDecoderCache.get(whatwgName)!;
  }

  try {
    const decoder = new TextDecoder(whatwgName, { fatal: false });
    textDecoderCache.set(whatwgName, decoder);
    return decoder;
  } catch {
    return null;
  }
}

// Patch pg-protocol's BufferReader to decode WIN874 / CP874 and other non-UTF8 encodings natively
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BufferReader } = require('pg-protocol/dist/buffer-reader');
  if (BufferReader && !(BufferReader as any).__encodingPatched) {
    (BufferReader as any).__encodingPatched = true;
    const origString = BufferReader.prototype.string;
    const origCstring = BufferReader.prototype.cstring;

    BufferReader.prototype.string = function (length: number): string {
      const enc = (process.env.PGCLIENTENCODING || '').toUpperCase();
      let decoder = getDecoder(enc);
      if (!decoder && (enc === 'SQL_ASCII' || enc === 'ASCII')) {
        const fallback = (process.env.PG_SERVER_ENCODING || 'WIN874').toUpperCase();
        decoder = getDecoder(fallback);
      }

      if (decoder) {
        const slice = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        return decoder.decode(slice);
      }
      return origString.call(this, length);
    };

    BufferReader.prototype.cstring = function (): string {
      const enc = (process.env.PGCLIENTENCODING || '').toUpperCase();
      let decoder = getDecoder(enc);
      if (!decoder && (enc === 'SQL_ASCII' || enc === 'ASCII')) {
        const fallback = (process.env.PG_SERVER_ENCODING || 'WIN874').toUpperCase();
        decoder = getDecoder(fallback);
      }

      if (decoder) {
        const start = this.offset;
        let end = start;
        while (end < this.buffer.length && this.buffer[end++]) {}
        this.offset = end;
        const slice = this.buffer.subarray(start, end - 1);
        return decoder.decode(slice);
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
    clientEncoding?: string;
  } {
    if (!str || !str.trim()) return {};
    const trimmed = str.trim();
    if (trimmed.startsWith('postgresql://') || trimmed.startsWith('postgres://')) {
      try {
        const u = new URL(trimmed);
        const searchEnc = u.searchParams.get('client_encoding') || u.searchParams.get('encoding');
        return {
          host: u.hostname || undefined,
          port: u.port ? parseInt(u.port, 10) : undefined,
          database: u.pathname ? u.pathname.replace(/^\//, '') : undefined,
          user: u.username ? decodeURIComponent(u.username) : undefined,
          password: u.password ? decodeURIComponent(u.password) : undefined,
          clientEncoding: searchEnc || undefined
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
      else if (key === 'client_encoding' || key === 'clientencoding' || key === 'encoding') result.clientEncoding = val;
    }
    return result;
  }

  public async configureEncoding(client: Client): Promise<string> {
    const rawConnStr = this.config.connectionString?.trim();
    const parsedConn = rawConnStr ? PostgresCatalogClient.parseConnString(rawConnStr) : {};
    const explicitConfig = (this.config.clientEncoding && this.config.clientEncoding.toLowerCase() !== 'auto')
      ? this.config.clientEncoding.trim()
      : undefined;
    const desired = explicitConfig || parsedConn.clientEncoding?.trim();

    // 1. Explicit encoding configured by user (e.g. WIN874, TIS620, UTF8, SQL_ASCII, WIN1252)
    if (desired && desired.toLowerCase() !== 'auto') {
      const safeDesired = desired.replace(/[^a-zA-Z0-9_-]/g, '');
      try {
        await client.query(`SET client_encoding = '${safeDesired}';`);
        process.env.PGCLIENTENCODING = safeDesired;
        console.log(`DuckLake: Configured explicit client_encoding to '${safeDesired}'`);

        // Record server encoding for decoder context (useful for SQL_ASCII)
        try {
          const sRes = await client.query('SHOW server_encoding;');
          process.env.PG_SERVER_ENCODING = String(sRes.rows[0]?.server_encoding || '').trim();
        } catch (_) {}

        return safeDesired;
      } catch (err) {
        console.warn(`DuckLake: Custom client_encoding '${safeDesired}' failed:`, err);
      }
    }

    // 2. Auto-detect strategy:
    // Query server_encoding directly. In PostgreSQL, server_encoding is the actual encoding
    // of the database (e.g. WIN874, TIS620, UTF8, SQL_ASCII).
    let serverEnc = '';
    try {
      const res = await client.query('SHOW server_encoding;');
      serverEnc = String(res.rows[0]?.server_encoding || '').trim();
    } catch (_) {
      try {
        const res = await client.query("SELECT current_setting('server_encoding') as server_encoding;");
        serverEnc = String(res.rows[0]?.server_encoding || '').trim();
      } catch {
        // ignore
      }
    }

    if (serverEnc) {
      const safeServerEnc = serverEnc.replace(/[^a-zA-Z0-9_-]/g, '');
      process.env.PG_SERVER_ENCODING = safeServerEnc;
      const sUpper = safeServerEnc.toUpperCase();

      // If server is WIN874, TIS620, WIN1252, or any non-UTF8 database:
      // Setting client_encoding to match server_encoding eliminates the PostgreSQL
      // "character with byte sequence ... in encoding WIN874 has no equivalent in encoding UTF8" error,
      // because PostgreSQL performs ZERO character transcoding when client_encoding == server_encoding.
      if (sUpper !== 'UTF8' && sUpper !== 'UTF-8' && sUpper !== 'UNICODE') {
        try {
          await client.query(`SET client_encoding = '${safeServerEnc}';`);
          process.env.PGCLIENTENCODING = safeServerEnc;
          console.log(`DuckLake: Auto-detected server_encoding '${safeServerEnc}'. Client encoding synchronized.`);
          return safeServerEnc;
        } catch (err) {
          console.warn(`DuckLake: Failed to SET client_encoding to '${safeServerEnc}', trying SQL_ASCII fallback:`, err);
          try {
            await client.query("SET client_encoding = 'SQL_ASCII';");
            process.env.PGCLIENTENCODING = 'SQL_ASCII';
            return 'SQL_ASCII (auto)';
          } catch (_) {}
        }
      } else {
        // Server is UTF8
        process.env.PGCLIENTENCODING = 'UTF8';
        return 'UTF8';
      }
    }

    // 3. Fallback: check SHOW client_encoding
    try {
      const res = await client.query('SHOW client_encoding;');
      const activeEnc = String(res.rows[0]?.client_encoding || 'UTF8');
      process.env.PGCLIENTENCODING = activeEnc;
      return activeEnc;
    } catch (_) {
      process.env.PGCLIENTENCODING = 'UTF8';
      return 'UTF8';
    }
  }

  private async queryWithFallback(client: Client, sql: string): Promise<any> {
    try {
      return await client.query(sql);
    } catch (err: any) {
      const msg = String(err?.message || err);
      // Catch PostgreSQL character transcoding errors
      if (
        msg.includes('has no equivalent in encoding') ||
        msg.includes('invalid byte sequence for encoding') ||
        msg.includes('character with byte sequence')
      ) {
        console.warn(`DuckLake: Transcoding error detected: "${msg}". Attempting auto-recovery with client_encoding...`);
        try {
          const currentEnc = (process.env.PGCLIENTENCODING || '').toUpperCase();
          const targetEnc = currentEnc !== 'WIN874' ? 'WIN874' : 'SQL_ASCII';
          await client.query(`SET client_encoding = '${targetEnc}';`);
          process.env.PGCLIENTENCODING = targetEnc;
          if (!process.env.PG_SERVER_ENCODING) {
            process.env.PG_SERVER_ENCODING = 'WIN874';
          }
          console.log(`DuckLake: Retrying query with recovered client_encoding = '${targetEnc}'`);
          return await client.query(sql);
        } catch (retryErr) {
          throw err;
        }
      }
      throw err;
    }
  }

  private createClient(): Client {
    const rawConnStr = this.config.connectionString?.trim();
    const parsedConn = rawConnStr ? PostgresCatalogClient.parseConnString(rawConnStr) : {};

    const explicitConfig = (this.config.clientEncoding && this.config.clientEncoding.toLowerCase() !== 'auto')
      ? this.config.clientEncoding.trim()
      : undefined;
    const effectiveEncoding = explicitConfig || parsedConn.clientEncoding?.trim();
    const isCustom = !!effectiveEncoding && effectiveEncoding.toLowerCase() !== 'auto';
    const enc = isCustom ? effectiveEncoding : 'UTF8';

    process.env.PGCLIENTENCODING = enc;
    const clientOptions = isCustom ? `-c client_encoding=${enc}` : undefined;

    if (rawConnStr) {
      if (rawConnStr.startsWith('postgresql://') || rawConnStr.startsWith('postgres://')) {
        return new Client({
          connectionString: rawConnStr,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
          connectionTimeoutMillis: 5000,
          options: clientOptions
        });
      }

      if (parsedConn.host || parsedConn.database) {
        return new Client({
          host: parsedConn.host || this.config.host,
          port: parsedConn.port || this.config.port,
          database: parsedConn.database || this.config.database,
          user: parsedConn.user || this.config.user,
          password: parsedConn.password || this.config.password,
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
      const res = await this.queryWithFallback(client, 'SELECT version();');

      // Check if DuckLake metastore is detected
      let hasDuckLake = false;
      try {
        const ducklakeCheck = await this.queryWithFallback(client, "SELECT to_regclass('public.ducklake_table') as has_ducklake;");
        hasDuckLake = !!ducklakeCheck.rows[0]?.has_ducklake;
      } catch {
        // ignore
      }

      let extra = '';
      if (hasDuckLake) {
        try {
          const countRes = await this.queryWithFallback(client, "SELECT COUNT(*) FROM ducklake_table WHERE end_snapshot IS NULL;");
          const count = countRes.rows[0]?.count ?? 0;
          extra = ` (DuckLake Metastore detected: ${count} active lakehouse tables)`;
        } catch {
          // ignore
        }
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

      // 🦆 1. DUCKLAKE METASTORE PARSING (if exists)
      try {
        const ducklakeCheck = await this.queryWithFallback(client, "SELECT to_regclass('public.ducklake_table') as has_ducklake;");
        const hasDuckLake = !!ducklakeCheck.rows[0]?.has_ducklake;

        if (hasDuckLake) {
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
            this.queryWithFallback(client, tablesQuery),
            this.queryWithFallback(client, columnsQuery)
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

          // DuckLake Views
          try {
            const viewCheck = await this.queryWithFallback(client, "SELECT to_regclass('public.ducklake_view') as has_view;");
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
              const viewsResult = await this.queryWithFallback(client, viewsQuery);
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
      } catch (lakeErr) {
        console.warn('DuckLake metastore query skipped or failed:', lakeErr);
      }

      // 🐘 2. POSTGRESQL TABLES & VIEWS ACROSS ALL SCHEMAS
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

        let pgTablesRes: any;
        try {
          pgTablesRes = await this.queryWithFallback(client, pgTablesQuery);
        } catch (tErr) {
          console.warn('DuckLake: pgTablesQuery failed, retrying without obj_description comments:', tErr);
          const safePgTablesQuery = `
            SELECT 
              t.table_schema,
              t.table_name,
              t.table_type,
              NULL as table_comment
            FROM information_schema.tables t
            WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND t.table_name NOT LIKE 'ducklake_%'
            ORDER BY t.table_schema, t.table_name;
          `;
          pgTablesRes = await this.queryWithFallback(client, safePgTablesQuery);
        }

        let pgColumnsRes: any;
        try {
          pgColumnsRes = await this.queryWithFallback(client, pgColumnsQuery);
        } catch (cErr) {
          console.warn('DuckLake: pgColumnsQuery failed, retrying without col_description comments:', cErr);
          const safePgColumnsQuery = `
            SELECT 
              c.table_schema,
              c.table_name,
              c.column_name,
              c.data_type,
              c.is_nullable,
              c.column_default,
              NULL as column_comment
            FROM information_schema.columns c
            WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
              AND c.table_name NOT LIKE 'ducklake_%'
            ORDER BY c.table_schema, c.table_name, c.ordinal_position;
          `;
          pgColumnsRes = await this.queryWithFallback(client, safePgColumnsQuery);
        }

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
