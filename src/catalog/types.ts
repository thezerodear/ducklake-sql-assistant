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
  catalog?: string;
  dataStorage?: string;
  dataPath?: string;
  overrideDataPath?: boolean;
  databaseAlias?: string;
}

export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';

export interface CatalogState {
  status: ConnectionState;
  tables: Map<string, TableMetadata>; // keyed by tableName and fullName
  lastRefreshed?: Date;
  errorMessage?: string;
}
