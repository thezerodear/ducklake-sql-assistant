import { Client, ClientConfig } from 'pg';
import { TableMetadata, ColumnMetadata, PostgresConfig } from './types';

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

    const cleaned = trimmed.replace(/^postgres:/, '').trim();
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

  private createClient(): Client {
    const rawConnStr = this.config.connectionString?.trim();
    if (rawConnStr) {
      if (rawConnStr.startsWith('postgresql://') || rawConnStr.startsWith('postgres://')) {
        return new Client({
          connectionString: rawConnStr,
          ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
          connectionTimeoutMillis: 5000
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
          connectionTimeoutMillis: 5000
        });
      }

      return new Client({
        connectionString: rawConnStr,
        ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 5000
      });
    }

    const clientConfig: ClientConfig = {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 5000
    };

    return new Client(clientConfig);
  }

  public async testConnection(): Promise<{ success: boolean; message: string; version?: string }> {
    const client = this.createClient();
    try {
      await client.connect();
      const res = await client.query('SELECT version();');

      // Check if DuckLake metastore is detected
      const ducklakeCheck = await client.query("SELECT to_regclass('public.ducklake_table') as has_ducklake;");
      const hasDuckLake = !!ducklakeCheck.rows[0]?.has_ducklake;

      let extra = '';
      if (hasDuckLake) {
        const countRes = await client.query("SELECT COUNT(*) FROM ducklake_table WHERE end_snapshot IS NULL;");
        extra = ` (DuckLake Metastore detected: ${countRes.rows[0].count} active lakehouse tables)`;
      }

      await client.end();
      return {
        success: true,
        message: `Successfully connected to PostgreSQL!${extra}`,
        version: res.rows[0]?.version
      };
    } catch (err: any) {
      try {
        await client.end();
      } catch {
        // ignore
      }
      return {
        success: false,
        message: `Failed to connect to PostgreSQL: ${err.message || err}`
      };
    }
  }

  public async fetchCatalog(): Promise<TableMetadata[]> {
    const client = this.createClient();
    try {
      await client.connect();

      // Check if DuckLake metastore tables exist in PostgreSQL
      const ducklakeCheck = await client.query("SELECT to_regclass('public.ducklake_table') as has_ducklake;");
      const hasDuckLake = !!ducklakeCheck.rows[0]?.has_ducklake;

      if (hasDuckLake) {
        // 🦆 1. NATIVE DUCKLAKE METASTORE PARSING
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
          ORDER BY s.schema_name, t.table_name, CAST(c.column_order AS integer);
        `;

        const [tablesResult, columnsResult] = await Promise.all([
          client.query(tablesQuery),
          client.query(columnsQuery)
        ]);

        await client.end();

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

        const tables: TableMetadata[] = [];
        for (const row of tablesResult.rows) {
          const tableKey = `${row.schema_name}.${row.table_name}`;
          const cols = columnsByTable.get(tableKey) || [];

          tables.push({
            schema: row.schema_name,
            name: row.table_name,
            fullName: `${row.schema_name}.${row.table_name}`,
            type: row.table_type,
            columns: cols,
            comment: row.table_comment ?? undefined,
            rowCount: row.record_count != null ? parseInt(row.record_count, 10) : undefined,
            fileSizeBytes: row.file_size_bytes != null ? parseInt(row.file_size_bytes, 10) : undefined
          });
        }

        return tables;
      }

      // 🐘 2. STANDARD POSTGRESQL SCHEMA PARSING
      const schemas = this.config.catalogSchemas.length > 0 ? this.config.catalogSchemas : ['public'];
      const schemaPlaceholders = schemas.map((_, i) => `$${i + 1}`).join(', ');

      const tablesQuery = `
        SELECT 
          t.table_schema,
          t.table_name,
          t.table_type,
          obj_description(pgc.oid, 'pg_class') as table_comment
        FROM information_schema.tables t
        LEFT JOIN pg_catalog.pg_class pgc 
          ON pgc.relname = t.table_name
          AND pgc.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = t.table_schema)
        WHERE t.table_schema IN (${schemaPlaceholders})
        ORDER BY t.table_schema, t.table_name;
      `;

      const tablesResult = await client.query(tablesQuery, schemas);

      const columnsQuery = `
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
        WHERE c.table_schema IN (${schemaPlaceholders})
        ORDER BY c.table_schema, c.table_name, c.ordinal_position;
      `;

      const columnsResult = await client.query(columnsQuery, schemas);
      await client.end();

      const columnsByTable = new Map<string, ColumnMetadata[]>();
      for (const row of columnsResult.rows) {
        const tableKey = `${row.table_schema}.${row.table_name}`;
        if (!columnsByTable.has(tableKey)) {
          columnsByTable.set(tableKey, []);
        }

        columnsByTable.get(tableKey)!.push({
          name: row.column_name,
          dataType: row.data_type,
          isNullable: row.is_nullable === 'YES',
          defaultValue: row.column_default ?? undefined,
          comment: row.column_comment ?? undefined
        });
      }

      const tables: TableMetadata[] = [];
      for (const row of tablesResult.rows) {
        const tableKey = `${row.table_schema}.${row.table_name}`;
        const cols = columnsByTable.get(tableKey) || [];

        tables.push({
          schema: row.table_schema,
          name: row.table_name,
          fullName: `${row.table_schema}.${row.table_name}`,
          type: row.table_type,
          columns: cols,
          comment: row.table_comment ?? undefined
        });
      }

      return tables;
    } catch (err: any) {
      try {
        await client.end();
      } catch {
        // ignore
      }
      throw new Error(`Catalog query failed: ${err.message || err}`);
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
      }
    ];
  }
}
