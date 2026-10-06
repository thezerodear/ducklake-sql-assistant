export interface ColumnMetadata {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue?: string;
  comment?: string;
}

export interface TableMetadata {
  schema: string;
  name: string;
  fullName: string; // e.g. "public.users" or "users"
  type: 'BASE TABLE' | 'VIEW' | 'MATERIALIZED VIEW' | 'FOREIGN TABLE' | string;
  columns: ColumnMetadata[];
  comment?: string;
  rowCount?: number;
  fileSizeBytes?: number;
  viewDefinition?: string;
  databaseAlias?: string;
}

export interface DatabaseCatalog {
  connectionName: string;
  databaseAlias: string;
  status: ConnectionState;
  catalogType: 'server' | 'local';
  tables: TableMetadata[];
  lastRefreshed?: Date;
  errorMessage?: string;
  config: PostgresConfig;
}

export interface PostgresConfig {
  connectionString?: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl: boolean;
  catalogSchemas: string[];
  autoRefreshMinutes: number;
  enableSmartHeuristic: boolean;
  suggestDuckDBFunctions: boolean;
  duckdbDatabasePath?: string;
  alwaysEnableInTripleQuotes: boolean;
  connectionName?: string;
  catalogType?: string;
  clientEncoding?: string;
  dataStorage?: string;
  dataPath?: string;
  overrideDataPath?: boolean;
  databaseAlias?: string;
}

export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface CatalogState {
  status: ConnectionState;
  tables: Map<string, TableMetadata>; // keyed by tableName, fullName, and db.fullName
  databases: Map<string, DatabaseCatalog>;
  activeDatabase?: string;
  lastRefreshed?: Date;
  errorMessage?: string;
}

