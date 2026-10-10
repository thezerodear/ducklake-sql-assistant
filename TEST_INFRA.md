# DuckLake SQL Assistant — Test Infrastructure Documentation

## 1. Overview & Test Philosophy

The test infrastructure for `ducklake-sql-assistant` provides a headless, fast, and deterministic test environment executed via Node.js's native test runner (`node --test`). It verifies SQL syntax and schema diagnostics inside Python files (`.py`) and Jupyter notebook cells (`.ipynb`) without launching an external VS Code GUI process.

All test assertions adhere to a strict **Zero False Positives** rule for disconnected catalogs and **Progressive Testability** principles.

---

## 2. Test Infrastructure Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │               Test Runner                     │
                    │        node --test test/diagnostics.test.js  │
                    └──────────────────────┬───────────────────────┘
                                           │
             ┌─────────────────────────────┴─────────────────────────────┐
             ▼                                                           ▼
┌───────────────────────────────┐                       ┌───────────────────────────────┐
│     Headless VS Code Shim     │                       │     4-Tier Diagnostics Suite  │
│ (test/e2e/harness/vscodeShim) │                       │   (test/diagnostics.test.js)  │
├───────────────────────────────┤                       ├───────────────────────────────┤
│ • Diagnostic & Collection     │                       │ • Tier 1: Feature Coverage    │
│ • DiagnosticSeverity (0..3)   │                       │ • Tier 2: Boundary & Corners  │
│ • Document Event Emitters     │                       │ • Tier 3: Cross-Combinations  │
│ • Configuration Mocking       │                       │ • Tier 4: Real-World Scenarios│
│ • Uri parsing with Schemes    │                       │ • 67 Comprehensive Test Cases │
└──────────────┬────────────────┘                       └──────────────┬────────────────┘
               │                                                       │
               └───────────────────────────┬───────────────────────────┘
                                           ▼
                    ┌──────────────────────────────────────────────┐
                    │            System Under Test (SUT)           │
                    ├──────────────────────────────────────────────┤
                    │ • SqlDiagnosticsManager                      │
                    │ • SqlValidator & SqlTokenizer                │
                    │ • SchemaValidator                            │
                    │ • SqlDetector (findAllSqlBlocks)             │
                    └──────────────────────────────────────────────┘
```

---

## 3. Headless VS Code Mock Harness (`test/e2e/harness/vscodeShim.js`)

The harness intercepts VS Code module resolution using Node's internal `Module._resolveFilename` and maps `'vscode'` imports to `mockVscode`.

### Key Shim Components

1. **`DiagnosticSeverity` Enumeration**:
   - `Error: 0` (Red squiggly underlines)
   - `Warning: 1` (Yellow squiggly underlines)
   - `Information: 2`
   - `Hint: 3`

2. **`Diagnostic` Class**:
   - Represents a diagnostic marker with `range`, `message`, `severity`, `source: 'DuckLake SQL'`, `code`, `relatedInformation`, and `tags`.

3. **`DiagnosticCollection` Class**:
   - Implements `set(uri, diagnostics)`, `delete(uri)`, `clear()`, `get(uri)`, `has(uri)`, `forEach(callback)`, and `dispose()`.
   - Tracks diagnostics per document URI string (`Map<string, Diagnostic[]>`).
   - Registered under `mockVscode.languages._diagnosticCollections`.

4. **Document Lifecycle Event Emitters**:
   - `mockVscode.workspace.onDidChangeTextDocument`: Fires on document edit.
   - `mockVscode.workspace.onDidOpenTextDocument`: Fires on document open; automatically tracks document in `workspace.textDocuments`.
   - `mockVscode.workspace.onDidSaveTextDocument`: Fires on document save.
   - `mockVscode.workspace.onDidCloseTextDocument`: Fires on document close; automatically evicts from `workspace.textDocuments`.
   - `mockVscode.workspace.onDidChangeConfiguration`: Fires on configuration updates.

5. **URI Parser with Scheme Preservation**:
   - `Uri.parse(uriStr)` parses scheme (e.g. `file`, `vscode-notebook-cell`, `untitled`) and file path without losing cell fragment identifiers.

6. **Configuration Management**:
   - Defaults:
     - `ducklake.diagnostics.enable`: `true`
     - `ducklake.diagnostics.checkSchema`: `true`
   - `setMockConfig(key, val)`: Dynamically updates settings and emits `onDidChangeConfiguration`.
   - `resetMockConfig()`: Restores defaults.

---

## 4. 4-Tier Test Suite Architecture (`test/diagnostics.test.js`)

The test suite contains **67 automated tests** divided across 4 tiers:

### Tier 1: Feature Coverage (48 tests, 11 sub-suites)
- **1. Unbalanced Parentheses (T1.1–T1.4)**: Unclosed opening paren `(`, unmatched closing paren `)`, balanced nested parens `((a + b) * (c + d))`, parens within string literals.
- **2. Trailing Commas (T1.5–T1.10)**: Commas before `FROM`, `WHERE`, `GROUP BY`, `ORDER BY`, `HAVING`, `LIMIT`, `)`, and EOF/terminator. Valid comma verification.
- **3. Incomplete Clauses & Dangling Operators (T1.11–T1.17)**: Missing table in `FROM` (`SELECT * FROM WHERE`), missing expressions in `SELECT`, incomplete `WHERE`/`GROUP BY`/`ORDER BY`, dangling binary operators (`=`, `+`, `AND`), dangling unary operators (`NOT`).
- **4. Unclosed Quotes (T1.18–T1.21)**: Unclosed string literal `'`, unclosed identifier `"`, SQL doubled quotes `''`, backslash escaped quotes `\'`.
- **5. Table Warnings against Catalog (T1.22–T1.26)**: Nonexistent table warning in `FROM` and `JOIN`, valid table verification, table function exemptions (`read_parquet`, `read_csv`, `range`), subquery exemptions in `FROM`/`JOIN`.
- **6. Column Warnings against Table Schema (T1.27–T1.30)**: Valid qualified columns, nonexistent qualified column on table, qualified column on table alias, wildcard (`u.*`) acceptance.
- **7. CTE Handling (T1.31–T1.34)**: Single CTE (`WITH cte AS`), dynamic CTE column reference exemption, multiple chained CTEs, recursive CTEs (`WITH RECURSIVE`).
- **8. Table Alias Handling (T1.35–T1.36)**: Alias without `AS`, alias with `AS`.
- **9. Disconnected/Empty Catalog Zero-False-Positive Rule (T1.37–T1.40)**: Zero schema warnings when catalog status is `disconnected`, `error`, or empty (`tables.length === 0`). Verifies syntax errors continue to be reported.
- **10. Debounce 300ms & Document Lifecycle (T1.41–T1.46)**: Typing changes debounced by 300ms, rapid typing timer cancellation, immediate validation on open and save, immediate catalog schema refresh across open documents, cleanup on document close.
- **11. Configuration Settings (T1.47–T1.48)**: Master toggle `ducklake.diagnostics.enable = false` clears collection; `ducklake.diagnostics.checkSchema = false` preserves syntax errors while suppressing schema warnings.

### Tier 2: Boundary & Corner Cases (11 tests)
- **T2.1**: Empty SQL strings and whitespace-only SQL strings produce zero diagnostics.
- **T2.2–T2.3**: Single-line (`--`) and block (`/* */`) comments containing invalid SQL, unmatched parens, or keywords are ignored.
- **T2.4–T2.6**: Thai Unicode table and column names (`ตารางลูกค้า`, `รหัส`, `ชื่อ`) resolved cleanly; missing Thai column or table triggers exact warnings.
- **T2.7–T2.8**: Deeply nested parentheses (5 levels) balanced vs unbalanced.
- **T2.9**: Multiple chained CTEs (`a -> b -> c`).
- **T2.10**: Multi-block Python document (3 separate `con.sql("""...""")` calls) with independent range mappings.
- **T2.11**: Jupyter Notebook cell document URI (`vscode-notebook-cell`) integration.

### Tier 3: Cross-Feature Combinations (4 tests)
- **T3.1**: CTE with table alias and qualified column access (`WITH ... SELECT s.cnt FROM user_summary s`).
- **T3.2**: Syntax error located inside CTE definition flagged with exact range.
- **T3.3**: Query with valid syntax but phantom table emits 0 Errors and exactly 1 Warning.
- **T3.4**: Disconnected catalog with syntax error flags syntax error (Error) while suppressing schema warning (0 Warnings).

### Tier 4: Real-World Scenarios (4 tests)
- **T4.1**: Complex DuckDB ETL script with window functions (`row_number()`, `dense_rank()`), CTEs, joins, and aggregations passes with 0 diagnostics.
- **T4.2**: Jupyter notebook lakehouse query using `ATTACH 'ducklake:postgres:...' AS lake` and multi-table join passes cleanly.
- **T4.3**: Mixed error document: single script with both syntax Error (trailing comma) and schema Warning (invalid table) positioned on correct distinct lines.
- **T4.4**: Interactive editing lifecycle simulation: broken document -> typing change -> 300ms debounce -> clean state -> closed document -> deleted collection.

---

## 5. How to Run the Tests

### Single Diagnostics Test Suite
```powershell
fnm env | Out-String | Invoke-Expression
node --test test/diagnostics.test.js
```

### Full Project Test Suite (All 105 Tests)
```powershell
fnm env | Out-String | Invoke-Expression
node --test test/qol_improvements.test.js test/diagnostics.test.js
```

### Clean TypeScript Compilation
```powershell
fnm env | Out-String | Invoke-Expression
npm.cmd run compile
```

---

## 6. Test Suite Metrics

| Metric | Diagnostics Suite (`test/diagnostics.test.js`) | Full Repo Suite (`qol` + `diagnostics`) |
|---|---|---|
| **Total Tests** | 67 | 105 |
| **Suites** | 16 | 21 |
| **Pass Rate** | 100% (67 / 67) | 100% (105 / 105) |
| **Failures** | 0 | 0 |
| **Execution Duration** | ~1.69s | ~1.74s |
| **External Dependencies** | 0 (pure headless mock) | 0 |
