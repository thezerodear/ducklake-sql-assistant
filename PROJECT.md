# Project: PostgreSQL 17 WIN874 Automated Integration Test Suite

## Architecture
- **Environment**: Node.js v24 (native `node:test` and `node:assert`), Windows x64.
- **Database Engine**: Live local PostgreSQL 17 (`C:\Users\theze\Downloads\spiderman\postgresql-17.11-3-windows-x64-binaries\pgsql\bin`) configured with `WIN874` database encoding and Thai locale (`Thai_Thailand.874` / `--no-locale`).
- **Lakehouse Engine**: DuckDB CLI v1.5.5 with `ducklake` and `postgres` extensions.
- **Client Modules Under Test**:
  - `PostgresCatalogClient` (`src/catalog/postgresClient.ts`)
  - `SchemaManager` (`src/catalog/schemaManager.ts`)
  - `extension.ts` connection string / ATTACH generator helpers
- **Test Infrastructure**:
  - `test/integration/harness/pgHarness.ts`: Lifecycle management for PostgreSQL 17 (`initdb`, `pg_ctl start` with stdio ignore, `pg_isready`, seed DDL, fail-safe `pg_ctl stop` + PID `taskkill`).
  - `test/integration/harness/vscodeShim.ts`: Headless mock shim for `vscode` module allowing `SchemaManager` execution without VS Code runtime.
  - `test/integration/suites/`: Test suites executed via `node:test`.
  - `test/integration/run.ts` (or runner script): Master CLI runner wired to `npm run test:integration`.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | PG17 Binary Detection & Cluster Init | Detect PG17 binaries and initialize WIN874 cluster via `initdb -E WIN874 --locale=Thai_Thailand.874` | M1 | ORIGINAL_REQUEST §R1 |
| F2 | Isolated Port & Lifecycle Daemon | Start PG17 with `pg_ctl` on isolated port (e.g. 5439) with stdio ignore, health check via `pg_isready` | M1 | ORIGINAL_REQUEST §R1 |
| F3 | DuckLake Metastore Schema Seeding | Seed PostgreSQL with DuckLake tables (`ducklake_table`, `ducklake_column`, `ducklake_view`, `ducklake_table_stats`, `ducklake_schema`, `ducklake_snapshot`) | M1 | ORIGINAL_REQUEST §R1 |
| F4 | Native Thai Table & Comment Fixtures | Seed PostgreSQL with native Thai tables (`ตารางลูกค้า`, `คำสั่งซื้อ`), Thai columns, and comments (`obj_description`, `col_description`) | M1 | ORIGINAL_REQUEST §R1 |
| F5 | Corrupt Comment Fault Injection Fixture | Seed table with unmapped WIN874 byte sequence (e.g. `\xdb`) to trigger SQLSTATE 22P05 under UTF8 for resilience testing | M1 | ORIGINAL_REQUEST §R2 |
| F6 | Connection & Encoding Auto-Detection | `PostgresCatalogClient.testConnection()` detects active `WIN874` encoding and DuckLake metastore presence | M2 | ORIGINAL_REQUEST §R2 |
| F7 | Catalog Introspection & Thai Decoding | `fetchCatalog()` retrieves DuckLake and native tables, accurately decoding Thai names and comments into JS strings | M2 | ORIGINAL_REQUEST §R2 |
| F8 | Comment Fault Resilience & Fallback | Verify `fetchCatalog()` recovers gracefully on corrupt comments/unmapped byte sequences without aborting catalog load | M2 | ORIGINAL_REQUEST §R2 |
| F9 | SchemaManager Multi-Catalog Coordination | Headless execution of `SchemaManager` coordinating catalogs with VS Code shim | M2 | ORIGINAL_REQUEST §R2 |
| F10 | DuckLake Connection String Generation | Verify extension generated DuckLake ATTACH strings do not inject conflicting client encoding options | M3 | ORIGINAL_REQUEST §R3 |
| F11 | DuckLake & DuckDB Normal Query Execution | End-to-end DuckDB attach to PostgreSQL metastore, executing `SELECT *`, `SHOW TABLES` without transcoding errors | M3 | ORIGINAL_REQUEST §R3 |
| F12 | Thai Data/Metadata Query Execution | Verify DuckDB queries against tables/views containing Thai names and values | M3 | ORIGINAL_REQUEST §R3 |
| F13 | Single Test Command Execution | `npm run test:integration` builds extension and runs the complete integration test suite | M4 | ORIGINAL_REQUEST §R4 |
| F14 | Clean Process Lifecycle & Zero Orphans | Teardown guarantees clean server stop (`pg_ctl stop -m fast` + PID fallback), removing temp dirs and leaving 0 hanging processes | M4 | ORIGINAL_REQUEST §R4 |
| F15 | E2E Acceptance & Adversarial Hardening | Pass 100% of E2E test suite (Tiers 1-4) and harden via Tier 5 adversarial coverage testing | M5 | ORIGINAL_REQUEST Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | PostgreSQL 17 Test Harness & Fixtures | Implement `pgHarness.ts` with WIN874 init, lifecycle control, DuckLake schema seeding, Thai fixtures, and fault injection | none | DONE |
| M2 | Catalog Introspection & Thai Decoding Suite | Implement test suite for `PostgresCatalogClient` and `SchemaManager` with VS Code shim, verifying encoding auto-detection, Thai decoding, and comment fault resilience | M1 | PLANNED |
| M3 | DuckLake Query Execution Suite | Implement test suite verifying DuckLake ATTACH string generation, DuckDB engine attach, `SELECT *`, `SHOW TABLES`, and Thai query execution | M1 | PLANNED |
| M4 | Test Runner CLI & Lifecycle Integration | Implement `npm run test:integration` command, compilation hook, unified test runner, and fail-safe teardown | M1, M2, M3 | PLANNED |
| M5 | Final Milestone: 100% E2E Pass & Adversarial Hardening | Pass 100% of E2E test suite (Tiers 1-4) followed by Tier 5 adversarial coverage hardening | M4 | PLANNED |

## Interface Contracts

### Harness ↔ Test Suites (`test/integration/harness/pgHarness.ts`)
```typescript
export interface HarnessConfig {
  binDir: string;
  dataDir: string;
  port: number;
  database: string;
  user: string;
}

export interface PgHarness {
  start(): Promise<void>;
  stop(): Promise<void>;
  seedFixtures(): Promise<void>;
  getConnectionConfig(): { host: string; port: number; database: string; user: string };
  getDuckDbAttachString(alias: string, dataPath: string): string;
}
```

### Test Runner ↔ NPM (`package.json`)
```json
{
  "scripts": {
    "test:integration": "node test/integration/run.js"
  }
}
```

## Code Layout
- `src/`: Core extension source code (read-only for tests; only bugfixes if required)
  - `src/catalog/postgresClient.ts`
  - `src/catalog/schemaManager.ts`
  - `src/extension.ts`
- `test/integration/`: Integration test implementation
  - `test/integration/harness/pgHarness.ts` (or `.js`): PostgreSQL 17 WIN874 lifecycle & fixture management
  - `test/integration/harness/vscodeShim.ts` (or `.js`): Headless VS Code mock shim
  - `test/integration/suites/catalogIntrospection.test.ts` (or `.js`): Introspection & Thai decoding tests
  - `test/integration/suites/ducklakeQuery.test.ts` (or `.js`): DuckLake & DuckDB query tests
  - `test/integration/run.ts` (or `.js`): Master non-interactive runner
- `test/e2e/`: Opaque-box E2E test suite managed by E2E Testing Track
