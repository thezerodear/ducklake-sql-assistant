# DuckLake SQL Assistant — E2E Test Infrastructure Specification

**Document Version**: 1.0.0  
**Target Environment**: Node.js v24 (x64 Windows), PostgreSQL 17.11 (MSVC x64), DuckDB v1.5.5  
**Working Directory**: `test/e2e/`  

---

## 1. Test Philosophy & Design Principles

The end-to-end (E2E) test infrastructure for `ducklake-sql-assistant` is designed under the **opaque-box, requirement-driven verification** philosophy:

1. **Opaque-Box Testing**:
   - Tests interact strictly with public contracts, exported APIs (`PostgresCatalogClient`, `SchemaManager` with headless shim), PostgreSQL network wire protocols, and CLI binaries (`pg_ctl.exe`, `initdb.exe`, `psql.exe`, `duckdb.exe`).
   - Tests make zero assumptions about internal private state variables or unexported functions.
   - Behavior is evaluated by observable outcomes: query results, returned metadata objects, decoded Unicode characters, connection status payloads, and process exit codes.

2. **Requirement-Driven & Ground-Truth Derived**:
   - Every test case directly traces back to the primary requirements defined in `ORIGINAL_REQUEST.md` (R1 through R4) and the feature breakdown in `PROJECT.md` (F1 through F14).
   - Expected outputs are derived from authoritative ground-truth:
     - Live PostgreSQL 17 server responses and system catalog queries.
     - WHATWG `TextDecoder('windows-874')` specification and Thai Industrial Standard TIS-620 / CP874 codepage mappings.
     - DuckLake lakehouse specification and DuckDB metadata engine constraints.

3. **Deterministic Lifecycle & Zero Process Leakage**:
   - Tests execute against an isolated, automated PostgreSQL 17 WIN874 instance on a dedicated non-default test port (e.g. 54332).
   - Spawned daemons use `stdio: 'ignore'` to prevent Windows handle inheritance deadlocks.
   - Teardown implements multi-layered guarantees (`pg_ctl stop -m fast` followed by PID-level verification and fallback cleanup), ensuring zero orphan processes remain on the test host.

4. **Progressive Testability & Isolation**:
   - Each test tier builds predictably upon validated foundations.
   - Tests are self-contained: each test suite sets up required fixtures, verifies its invariants, and handles cleanup cleanly.

---

## 2. Feature Inventory & Coverage Criteria

The E2E test suite comprehensively verifies 14 functional features (F1 through F14) across four rigorous coverage tiers.

### 2.1 Feature Inventory Table

| Feature ID | Feature Name | Description | Source Requirement |
|---|---|---|---|
| **F1** | PG17 Binary Detection & Cluster Init | Detect PostgreSQL 17 binaries and initialize WIN874 cluster via `initdb -E WIN874 --locale=Thai_Thailand.874 -A trust`. | `ORIGINAL_REQUEST §R1` |
| **F2** | Isolated Port & Lifecycle Daemon | Start PG17 daemon on isolated test port with `stdio: 'ignore'` and verify readiness via `pg_isready`. | `ORIGINAL_REQUEST §R1` |
| **F3** | DuckLake Metastore Schema Seeding | Seed metastore tables (`ducklake_schema`, `ducklake_table`, `ducklake_column`, `ducklake_view`, `ducklake_table_stats`). | `ORIGINAL_REQUEST §R1` |
| **F4** | Native Thai Table & Comment Fixtures | Seed native PostgreSQL tables with Thai identifiers (`ตารางลูกค้า`, `คำสั่งซื้อ`), Thai columns, and comments (`obj_description`, `col_description`). | `ORIGINAL_REQUEST §R1` |
| **F5** | Corrupt Comment Fault Injection Fixture | Seed tables with unmapped WIN874 byte sequences (e.g. `\xdb`) to trigger SQLSTATE 22P05 under UTF8 for resilience testing. | `ORIGINAL_REQUEST §R1`, `§R2` |
| **F6** | Connection & Encoding Auto-Detection | `PostgresCatalogClient.testConnection()` detects active `WIN874` server encoding and DuckLake metastore presence. | `ORIGINAL_REQUEST §R2` |
| **F7** | Catalog Introspection & Thai Decoding | `fetchCatalog()` retrieves DuckLake and native tables, accurately decoding Thai names and comments into JavaScript Unicode strings. | `ORIGINAL_REQUEST §R2` |
| **F8** | Comment Fault Resilience & Fallback | Verify `fetchCatalog()` recovers gracefully when corrupt comments or unmapped byte sequences are encountered without failing catalog load. | `ORIGINAL_REQUEST §R2` |
| **F9** | SchemaManager Multi-Catalog Coordination | Headless execution of `SchemaManager` coordinating catalogs with headless VS Code mock shim. | `ORIGINAL_REQUEST §R2` |
| **F10** | DuckLake Connection String Generation | Verify extension generated DuckLake ATTACH strings strip conflicting `client_encoding` parameters for DuckDB compatibility. | `ORIGINAL_REQUEST §R3` |
| **F11** | DuckLake & DuckDB Normal Query Execution | End-to-end DuckDB attach to PostgreSQL metastore, executing `SELECT *`, `SHOW TABLES` without transcoding errors. | `ORIGINAL_REQUEST §R3` |
| **F12** | Thai Data/Metadata Query Execution | Verify DuckDB queries against lakehouse tables and views containing Thai names and string values. | `ORIGINAL_REQUEST §R3` |
| **F13** | Single Test Command Execution | Single non-interactive command (`npm run test:e2e` / `node test/e2e/runE2E.js`) compiles, runs tests, and exits with code 0 on success. | `ORIGINAL_REQUEST §R4` |
| **F14** | Clean Process Lifecycle & Zero Orphans | Teardown guarantees clean server stop (`pg_ctl stop -m fast` + PID fallback), removes temporary directories, and leaves 0 hanging processes. | `ORIGINAL_REQUEST §R4` |

---

## 3. Four-Tier Test Architecture

The E2E test suite is partitioned into four distinct tiers, with formal test case counts and coverage criteria:

```
test/e2e/
├── harness/
│   ├── pgE2EHarness.js         # PG17 WIN874 cluster lifecycle & port isolation
│   ├── fixtureSeeder.js        # DDL seeder for DuckLake metastore, Thai fixtures, corrupt comments
│   └── vscodeShim.js           # Lightweight headless VS Code mock shim for SchemaManager
├── tier1_features.test.js      # Tier 1: Feature Isolation Tests (>=5 cases per feature F1-F14)
├── tier2_boundary.test.js      # Tier 2: Boundary & Corner Cases (>=5 cases per feature F1-F14)
├── tier3_combinations.test.js  # Tier 3: Cross-Feature Pairwise Combinations
├── tier4_real_world.test.js    # Tier 4: Real-World Workload Scenarios
└── runE2E.js                   # Master non-interactive runner executing all tiers with node:test
```

### Tier 1: Feature Coverage (>= 5 test cases per feature)
Verifies each feature (F1 through F14) in isolated conditions:
- **F1 (PG17 Binaries & Init)**: Binary detection, version string verification, WIN874 initdb validation, Thai locale validation, data directory structure check.
- **F2 (Isolated Port & Lifecycle)**: Startup on custom port, `stdio: 'ignore'` verification, `pg_isready` exit code 0 probe, PID file verification, TCP port listen verification.
- **F3 (DuckLake Metastore Seeding)**: Metastore table creation, column metadata population, snapshot isolation constraints, statistics seeding, view definition registration.
- **F4 (Native Thai Fixtures)**: Thai table names (`ตารางลูกค้า`), Thai column names (`ชื่อลูกค้า`), table comments (`obj_description`), column comments (`col_description`), mixed alphanumeric Thai identifiers.
- **F5 (Corrupt Comment Fixtures)**: Insertion of unmapped byte sequences (`\xdb`), isolation of corrupt comment, verification of error under UTF-8 client_encoding, SQLSTATE 22P05 reproduction, non-corrupt table comment co-existence.
- **F6 (Connection & Encoding Detection)**: `testConnection()` success boolean, WIN874 encoding string detection, server_encoding sync confirmation, DuckLake table count detection, version string return.
- **F7 (Catalog Introspection & Thai Decoding)**: `fetchCatalog()` retrieves DuckLake tables, retrieves native tables, accurately decodes Thai table names, decodes Thai comments, verifies column data types.
- **F8 (Comment Fault Resilience)**: Catalog load succeeds despite corrupt comments, fallback without comments executed, valid tables still returned, error logging without unhandled rejection, resilient column metadata extraction.
- **F9 (SchemaManager Coordination)**: SchemaManager instantiation with shim, active database configuration, table resolution (`findTable`), column resolution (`getColumnsForTable`), multi-catalog state emission.
- **F10 (DuckLake Connection String Generation)**: Connection string parser, stripping `client_encoding=WIN874`, stripping URL format `?client_encoding=...`, preserving host/port/database parameters, formatting `ATTACH 'ducklake:postgres:...'` clause.
- **F11 (DuckLake & DuckDB Normal Queries)**: DuckDB CLI execution, loading `ducklake` and `postgres` extensions, executing `SHOW TABLES`, executing `SELECT *`, executing count queries without transcode errors.
- **F12 (Thai Data/Metadata Queries)**: DuckDB querying Thai table names, DuckDB selecting Thai column values, DuckDB filtering by Thai string literals, DuckDB aggregate queries on Thai tables, DuckDB view execution over Thai data.
- **F13 (Single Command Execution)**: Non-interactive execution, stdout test reporter output, exit code 0 propagation on pass, exit code 1 propagation on failure, execution duration reporting.
- **F14 (Clean Lifecycle & Zero Orphans)**: Graceful stop via `pg_ctl -m fast`, PID termination verification, socket release verification, temp directory cleanup, absence of lingering `postgres.exe` in process table.

### Tier 2: Boundary & Corner Cases (>= 5 test cases per feature)
Challenges system stability, boundary parameters, and adversarial edge cases across F1 through F14:
- Empty metastore tables (0 active tables, null snapshots).
- Maximum-length Thai table identifiers (up to 63 bytes in PostgreSQL `NAMEDATALEN`).
- Tone mark sequences and combining characters (e.g. `น้ำ`, `ผู้ใหญ่`, mai ek, mai tho, sara am).
- Mixed Thai and special ASCII symbols (hyphens, underscores, dots, parentheses).
- Highly corrupt comment bytes (multiple invalid bytes, control characters, null bytes).
- Rapid client reconnects (burst of 10 connections in rapid sequence).
- Connection attempts to closed or invalid ports (fast failure timeout).
- Re-binding to recently closed ports (handling Windows `TIME_WAIT` / `WSAEADDRINUSE`).
- Malformed DuckLake ATTACH strings (empty strings, missing parameters, invalid URI syntax).
- Boundary table statistics (0 records, 0 bytes, large integers exceeding 32 bits).
- Concurrent catalog introspections from multiple client instances.
- Zero-column edge case tables and wide tables with 50+ columns.
- Multiple schemas beyond `public` containing duplicate table names.
- Shutdown resilience when client connections are active.

### Tier 3: Cross-Feature Combinations (Pairwise Interactions)
Verifies interoperability when multiple features operate simultaneously:
- **Combo 1 (F3 + F4 + F7)**: Simultaneous introspection of DuckLake metastore and native Thai tables with comments.
- **Combo 2 (F5 + F7 + F8)**: Catalog introspection with corrupt comments coexisting alongside valid Thai comments.
- **Combo 3 (F6 + F7 + F9)**: SchemaManager coordinating connection auto-detection, WIN874 decoding, and multi-database catalog caching.
- **Combo 4 (F10 + F11 + F12)**: End-to-end DuckLake connection string generation fed into DuckDB engine querying Thai lakehouse tables.
- **Combo 5 (F2 + F6 + F14)**: Full daemon lifecycle cycle (start -> testConnection -> fetchCatalog -> stop) executed consecutively across different ports.

### Tier 4: Real-World Workload Scenarios
Simulates complete, production-grade lakehouse workflows:
- **Scenario 1**: Data Analyst Workflow — Connect to PostgreSQL metastore, introspect multi-catalog schemas, find customer table (`ตารางลูกค้า`), inspect columns, and generate DuckLake Python query script.
- **Scenario 2**: Lakehouse Migration Workflow — Seed native PostgreSQL database with Thai transactional data, attach DuckLake metastore, execute DuckDB queries joining native and lakehouse tables, and verify data fidelity.
- **Scenario 3**: Resilient Production Session — Long-lived SchemaManager session with auto-refresh, handling transient corrupt table comments, refreshing catalog, and cleanly disposing all resources.

---

## 4. Test Runner Specification

The test suite is driven by `test/e2e/runE2E.js` utilizing Node.js's native `node:test` runner and `node:assert`:

### 4.1 Invocation
```bash
node test/e2e/runE2E.js
```
Or via npm script:
```bash
npm run test:e2e
```

### 4.2 Lifecycle Flow of `runE2E.js`
1. **Pre-flight Check**: Verifies existence of PostgreSQL 17 binaries and Node.js v24 environment.
2. **Cluster Provisioning**:
   - Creates a dedicated temporary directory (`test/.pgdata_e2e`).
   - Runs `initdb.exe -E WIN874 --locale=Thai_Thailand.874 -A trust`.
   - Starts daemon on isolated port 54332 with `stdio: 'ignore'`.
   - Polls `pg_isready.exe` until connection is confirmed (timeout 15s).
3. **Database & Fixture Initialization**:
   - Creates test database `ducklake_e2e`.
   - Seeds DuckLake metastore tables, native Thai tables, columns, comments, and fault injection rows.
4. **Execution of Test Tiers**:
   - Runs Tier 1 (Feature Isolation Tests).
   - Runs Tier 2 (Boundary & Corner Cases).
   - Runs Tier 3 (Cross-Feature Combinations).
   - Runs Tier 4 (Real-World Scenarios).
5. **Fail-Safe Teardown**:
   - Executes `pg_ctl.exe stop -m fast`.
   - Verifies process termination via `tasklist`.
   - Cleans up temporary data directory.
   - Registers process listeners (`SIGINT`, `SIGTERM`, `uncaughtException`, `unhandledRejection`) to guarantee cleanup even if tests abort.
6. **Reporting & Exit**:
   - Summarizes total tests, passed, failed, duration.
   - Exits code 0 on 100% pass, code 1 on any failure.

---

## 5. Verification & Acceptance Criteria
- 100% test pass rate across all tiers (Tier 1 >= 70 tests, Tier 2 >= 70 tests, Tier 3 >= 5 tests, Tier 4 >= 3 tests).
- Zero orphan `postgres.exe` or `duckdb.exe` processes after runner exits.
- No unhandled promise rejections or unescaped transcoding errors during test execution.
