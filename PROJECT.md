# Project: DuckLake SQL Syntax & Schema Diagnostics

## Architecture
- **Environment**: Node.js v24, TypeScript 5.8, VS Code Extensibility API, Windows x64.
- **Language Integration**:
  - Python scripts (`.py`, language: `python`, scheme: `file` / `untitled`).
  - Jupyter Notebooks (`.ipynb`, language: `python`, scheme: `vscode-notebook-cell`).
- **Core Subsystems**:
  1. **SQL Discovery & Coordinate Mapper** (`src/parser/sqlDetector.ts`):
     - Batch extraction of all SQL string literals (triple quotes `"""`, `'''` and single quotes `"`, `'` satisfying SQL heuristics).
     - Global character offset to VS Code `Position` and `Range` mapping via `document.positionAt(startOffset + localOffset)`.
  2. **SQL Syntax & Semantic Validator** (`src/diagnostics/sqlValidator.ts`):
     - Zero-dependency lightweight tokenizer and syntax checker.
     - Detects unbalanced parentheses, trailing commas before keywords/parens/EOF, incomplete clauses, dangling operators, unclosed quotes.
     - Emits `vscode.DiagnosticSeverity.Error` with precise ranges.
  3. **Schema Validator** (`src/diagnostics/schemaValidator.ts`):
     - Validates `FROM` and `JOIN` table names against `SchemaManager` (`src/catalog/schemaManager.ts`).
     - Validates qualified column references (`table.col`, `alias.col`) against table schemas.
     - CTE (`WITH cte AS (...)`) and table alias awareness.
     - Bypasses built-in table functions (`read_parquet`, `read_csv`, `range`, etc.) and derived subqueries.
     - Disconnected / empty catalog graceful suppression (zero false positives when `status !== 'connected' || tables.length === 0`).
     - Emits `vscode.DiagnosticSeverity.Warning`.
  4. **Diagnostics Lifecycle Manager** (`src/diagnostics/diagnosticsManager.ts`):
     - Owns `vscode.DiagnosticCollection` (`ducklake-sql-diagnostics`).
     - Debounced validation (300ms) on `vscode.workspace.onDidChangeTextDocument`.
     - Immediate validation on `onDidOpenTextDocument`, `onDidSaveTextDocument`, and `schemaManager.onDidChangeSchema`.
     - Cleanup on `onDidCloseTextDocument` and extension deactivation.
     - Configuration toggles: `ducklake.diagnostics.enable` and `ducklake.diagnostics.checkSchema`.
  5. **Headless Test Harness & E2E Test Suite** (`test/e2e/harness/vscodeShim.js`, `test/diagnostics.test.js`):
     - Mocks `DiagnosticCollection`, `Diagnostic`, `DiagnosticSeverity`.
     - 4-Tier test suite covering syntax errors, schema checks, CTEs, debouncing, and settings.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Multi-Block SQL Discovery in Documents | Batch discovery of all SQL strings in Python and notebook cells with exact start/end offsets | M1 | ORIGINAL_REQUEST §1 |
| F2 | Parentheses Balance Validation | Detect and report unclosed `(` or unexpected `)` with `DiagnosticSeverity.Error` | M1 | ORIGINAL_REQUEST §1 |
| F3 | Trailing Comma Validation | Detect and report trailing commas before `FROM`, `WHERE`, `GROUP BY`, `ORDER BY`, `HAVING`, `LIMIT`, `)`, or EOF | M1 | ORIGINAL_REQUEST §1 |
| F4 | Incomplete Clauses & Dangling Operators | Detect dangling operators (`+`, `-`, `*`, `/`, `AND`, `OR`, `=`) and incomplete clauses (`SELECT * FROM WHERE`) | M1 | ORIGINAL_REQUEST §1 |
| F5 | Unclosed Quotes Validation | Detect unclosed single/double/backtick quotes inside SQL blocks | M1 | ORIGINAL_REQUEST §1 |
| F6 | Catalog Table Existence Verification | Check `FROM` and `JOIN` table references against `SchemaManager`; emit `DiagnosticSeverity.Warning` on unknown tables | M1 | ORIGINAL_REQUEST §2 |
| F7 | Qualified Column Schema Verification | Check `table.col` and `alias.col` against catalog columns; emit `DiagnosticSeverity.Warning` on unknown columns | M1 | ORIGINAL_REQUEST §2 |
| F8 | CTE & Table Alias Resolution | Recognize `WITH [RECURSIVE] cte AS (...)` and table aliases so they are not flagged as missing tables | M1 | ORIGINAL_REQUEST §2 |
| F9 | Disconnected / Empty Catalog Suppression | Zero false positives when catalog is disconnected or contains no tables | M1 | ORIGINAL_REQUEST §2 |
| F10 | Diagnostics Collection & Debounce Lifecycle | Manage `ducklake-sql-diagnostics` collection, 300ms debounce on edits, immediate on open/save/catalog refresh, cleanup on close | M2 | ORIGINAL_REQUEST §3 |
| F11 | Configuration Settings Contribution | Support `ducklake.diagnostics.enable` (default: true) and `ducklake.diagnostics.checkSchema` (default: true) in `package.json` | M2 | ORIGINAL_REQUEST §3 |
| F12 | Headless VS Code Diagnostics Shim | Add `createDiagnosticCollection`, `Diagnostic`, `DiagnosticSeverity` to `test/e2e/harness/vscodeShim.js` | M_TEST | ORIGINAL_REQUEST §4 |
| F13 | Programmatic Automated Test Suite | Comprehensive 4-Tier automated test suite in `test/diagnostics.test.js` executed via `node --test` | M_TEST | ORIGINAL_REQUEST §4 |
| F14 | Clean TypeScript Build | Clean compilation with zero errors (`npm run compile`) | M3 | ORIGINAL_REQUEST §4 |
| F15 | Extension Packaging (.vsix) | Successfully build and package extension into `.vsix` file | M3 | ORIGINAL_REQUEST §4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M_TEST | E2E Diagnostics Test Infrastructure & Suite | Test harness shim update in `vscodeShim.js`, 4-tier test cases in `test/diagnostics.test.js`, publish `TEST_READY.md` | none | IN_PROGRESS |
| M1 | SQL Validator & Schema Diagnostics Engine | Implement `src/parser/sqlDetector.ts` batch discovery, `src/diagnostics/sqlValidator.ts`, and `src/diagnostics/schemaValidator.ts` | none | IN_PROGRESS |
| M2 | Diagnostics Manager, Lifecycle & Config | Implement `src/diagnostics/diagnosticsManager.ts`, wire into `src/extension.ts`, register settings in `package.json` | M1 | PLANNED |
| M3 | Final Milestone: 100% E2E Pass, Adversarial Hardening, Build & VSIX | Pass 100% tests, adversarial coverage verification (Tier 5), verify clean compile (`npm run compile`), package `.vsix` | M_TEST, M1, M2 | PLANNED |

## Interface Contracts

### Diagnostics Validator Contract (`src/diagnostics/sqlValidator.ts`)
```typescript
import * as vscode from 'vscode';

export interface SqlDiagnosticItem {
  range: vscode.Range;
  message: string;
  severity: vscode.DiagnosticSeverity;
  code?: string | number;
}

export interface SqlValidationOptions {
  checkSyntax: boolean;
  checkSchema: boolean;
  catalogTables?: Map<string, { columns: string[] }>;
  isCatalogConnected: boolean;
}

export interface ISqlValidator {
  validateSql(
    document: vscode.TextDocument,
    sqlBlock: { text: string; startOffset: number; endOffset: number },
    options: SqlValidationOptions
  ): SqlDiagnosticItem[];
}
```

### Diagnostics Manager Contract (`src/diagnostics/diagnosticsManager.ts`)
```typescript
import * as vscode from 'vscode';
import { SchemaManager } from '../catalog/schemaManager';

export class SqlDiagnosticsManager implements vscode.Disposable {
  constructor(schemaManager: SchemaManager);
  public triggerValidation(document: vscode.TextDocument, immediate?: boolean): void;
  public clearDiagnostics(document: vscode.TextDocument): void;
  public dispose(): void;
}
```

## Code Layout
- `src/parser/sqlDetector.ts`: Add `findAllSqlBlocks(document: vscode.TextDocument): ExtractedSqlBlock[]`
- `src/diagnostics/sqlValidator.ts`: Pure syntax validation & tokenizer
- `src/diagnostics/schemaValidator.ts`: Schema reference validation against `SchemaManager`
- `src/diagnostics/diagnosticsManager.ts`: VS Code collection management, debouncing, event wiring
- `src/extension.ts`: Instantiate and register `SqlDiagnosticsManager` in `activate()`
- `package.json`: Add `ducklake.diagnostics.enable` and `ducklake.diagnostics.checkSchema` configuration properties
- `test/e2e/harness/vscodeShim.js`: Add `createDiagnosticCollection`, `Diagnostic`, `DiagnosticSeverity`
- `test/diagnostics.test.js`: E2E test suite covering syntax, schema, CTEs, debounce, and config
