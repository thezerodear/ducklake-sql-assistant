// test/diagnostics.test.js
// Comprehensive 4-Tier Automated Test Suite for DuckLake SQL Syntax & Schema Diagnostics

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const {
  mockVscode,
  setMockConfig,
  resetMockConfig,
  resetDiagnosticCollections,
  DiagnosticSeverity
} = require('./e2e/harness/vscodeShim');

const { SqlDetector } = require('../dist/parser/sqlDetector');
const { SqlValidator, SqlTokenizer } = require('../dist/diagnostics/sqlValidator');
const { SchemaValidator } = require('../dist/diagnostics/schemaValidator');
const { SqlDiagnosticsManager } = require('../dist/diagnostics/diagnosticsManager');

// Standard Catalog Schema Fixtures
const standardTables = [
  {
    schema: 'public',
    name: 'users',
    fullName: 'public.users',
    type: 'BASE TABLE',
    databaseAlias: 'lake',
    columns: [
      { name: 'id', dataType: 'integer', isNullable: false },
      { name: 'email', dataType: 'varchar', isNullable: false },
      { name: 'name', dataType: 'varchar', isNullable: true },
      { name: 'created_at', dataType: 'timestamp', isNullable: true }
    ]
  },
  {
    schema: 'public',
    name: 'orders',
    fullName: 'public.orders',
    type: 'BASE TABLE',
    databaseAlias: 'lake',
    columns: [
      { name: 'order_id', dataType: 'integer', isNullable: false },
      { name: 'user_id', dataType: 'integer', isNullable: false },
      { name: 'total_amount', dataType: 'numeric', isNullable: false },
      { name: 'status', dataType: 'varchar', isNullable: true }
    ]
  },
  {
    schema: 'public',
    name: 'ตารางลูกค้า',
    fullName: 'public.ตารางลูกค้า',
    type: 'BASE TABLE',
    databaseAlias: 'lake',
    columns: [
      { name: 'รหัส', dataType: 'integer', isNullable: false },
      { name: 'ชื่อ', dataType: 'varchar', isNullable: false },
      { name: 'ยอดเงิน', dataType: 'numeric', isNullable: true }
    ]
  }
];

// Mock Document Factory Helper
function createMockDocument(content, uriPath = 'c:/project/test.py', languageId = 'python') {
  const lines = content.split(/\r?\n/);
  const lineOffsets = [0];
  let cur = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    cur = content.indexOf('\n', cur) + 1;
    lineOffsets.push(cur);
  }

  const uri = uriPath.startsWith('vscode-notebook-cell:')
    ? mockVscode.Uri.parse(uriPath)
    : mockVscode.Uri.file(uriPath);

  return {
    uri,
    fileName: uriPath,
    languageId,
    getText: (range) => {
      if (!range) return content;
      const start = lineOffsets[range.start.line] + range.start.character;
      const end = lineOffsets[range.end.line] + range.end.character;
      return content.slice(start, end);
    },
    lineCount: lines.length,
    lineAt: (lineNum) => {
      const text = lines[lineNum] !== undefined ? lines[lineNum] : '';
      return {
        text,
        range: new mockVscode.Range(lineNum, 0, lineNum, text.length),
        rangeIncludingLineBreak: new mockVscode.Range(lineNum, 0, lineNum + 1, 0)
      };
    },
    offsetAt: (position) => {
      return (lineOffsets[position.line] || 0) + position.character;
    },
    positionAt: (offset) => {
      let line = 0;
      for (let i = 0; i < lineOffsets.length; i++) {
        if (offset >= lineOffsets[i]) {
          line = i;
        } else {
          break;
        }
      }
      return new mockVscode.Position(line, offset - lineOffsets[line]);
    }
  };
}

// Mock SchemaManager Factory Helper
function createMockSchemaManager(tables = standardTables, status = 'connected') {
  const onDidChangeSchemaEmitter = new mockVscode.EventEmitter();
  const tableMap = new Map();
  for (const t of tables) {
    tableMap.set(t.name.toLowerCase(), t);
    tableMap.set(t.fullName.toLowerCase(), t);
    if (t.databaseAlias) {
      tableMap.set(`${t.databaseAlias}.${t.name}`.toLowerCase(), t);
      tableMap.set(`${t.databaseAlias}.${t.fullName}`.toLowerCase(), t);
    }
  }

  return {
    _status: status,
    _tables: tables,
    _tableMap: tableMap,
    onDidChangeSchema: onDidChangeSchemaEmitter.event,
    _fireChange: function (newStatus, newTables) {
      if (newStatus !== undefined) this._status = newStatus;
      if (newTables !== undefined) {
        this._tables = newTables;
        this._tableMap.clear();
        for (const t of newTables) {
          this._tableMap.set(t.name.toLowerCase(), t);
          this._tableMap.set(t.fullName.toLowerCase(), t);
          if (t.databaseAlias) {
            this._tableMap.set(`${t.databaseAlias}.${t.name}`.toLowerCase(), t);
            this._tableMap.set(`${t.databaseAlias}.${t.fullName}`.toLowerCase(), t);
          }
        }
      }
      onDidChangeSchemaEmitter.fire(this.getState());
    },
    getState: function () {
      return {
        status: this._status,
        tables: this._tableMap,
        databases: new Map(),
        activeDatabase: 'lake'
      };
    },
    getTables: function () {
      if (this._status !== 'connected') return [];
      return this._tables;
    },
    findTable: function (nameOrAlias) {
      if (this._status !== 'connected') return undefined;
      return this._tableMap.get(nameOrAlias.toLowerCase());
    },
    getColumnsForTable: function (tableName) {
      if (this._status !== 'connected') return [];
      const tbl = this._tableMap.get(tableName.toLowerCase());
      return tbl ? tbl.columns : [];
    }
  };
}

describe('DuckLake SQL Diagnostics Test Suite', () => {
  beforeEach(() => {
    resetMockConfig();
    resetDiagnosticCollections();
    mockVscode.workspace.textDocuments = [];
  });

  afterEach(() => {
    resetDiagnosticCollections();
    mockVscode.workspace.textDocuments = [];
  });

  // =========================================================================
  // TIER 1: FEATURE COVERAGE
  // =========================================================================
  describe('Tier 1: Feature Coverage', () => {
    describe('1. Unbalanced Parentheses', () => {
      it('T1.1: Unclosed opening parenthesis emits DiagnosticSeverity.Error at the unclosed paren', () => {
        const code = `con.sql("""SELECT (a + b FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1, 'Expected at least 1 syntax error');
        assert.match(errors[0].message, /unclosed parenthesis/i);
        // Local index of '(' inside "SELECT (a + b FROM users" is 7
        // block starts at index 11 (after 'con.sql("""')
        assert.strictEqual(errors[0].range.start.character, 18);
        manager.dispose();
      });

      it('T1.2: Unmatched closing parenthesis emits DiagnosticSeverity.Error at the extra paren', () => {
        const code = `con.sql("""SELECT (a + b)) FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1, 'Expected at least 1 syntax error');
        assert.match(errors[0].message, /unmatched closing parenthesis/i);
        // Extra ')' is at local index 14, startOffset is 11 -> character 25
        assert.strictEqual(errors[0].range.start.character, 25);
        manager.dispose();
      });

      it('T1.3: Balanced nested parentheses produce zero syntax errors', () => {
        const code = `con.sql("""SELECT ((a + b) * (c + d)) FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.strictEqual(errors.length, 0, 'Expected 0 syntax errors for balanced parens');
        manager.dispose();
      });

      it('T1.4: Parentheses inside SQL string literals do not alter paren balance', () => {
        const code = `con.sql("""SELECT ')' AS paren FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.strictEqual(errors.length, 0, 'String literals with parens must be ignored');
        manager.dispose();
      });
    });

    describe('2. Trailing Commas', () => {
      it('T1.5: Trailing comma before FROM emits DiagnosticSeverity.Error', () => {
        const code = `con.sql("""SELECT id, email, FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1, 'Expected error for trailing comma before FROM');
        assert.match(errors[0].message, /trailing comma before 'FROM'/i);
        manager.dispose();
      });

      it('T1.6: Trailing comma before WHERE emits DiagnosticSeverity.Error', () => {
        const code = `con.sql("""SELECT * FROM users, WHERE id = 1""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1, 'Expected error for trailing comma before WHERE');
        assert.match(errors[0].message, /trailing comma before 'WHERE'/i);
        manager.dispose();
      });

      it('T1.7: Trailing comma before GROUP BY and ORDER BY emits DiagnosticSeverity.Error', () => {
        const code = `con.sql("""SELECT email, FROM users GROUP BY email""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1);
        assert.match(errors[0].message, /trailing comma before 'FROM'/i);
        manager.dispose();
      });

      it('T1.8: Trailing comma before closing parenthesis emits DiagnosticSeverity.Error', () => {
        const code = `con.sql("""SELECT * FROM users WHERE id IN (1, 2,)""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1, 'Expected error for trailing comma before )');
        assert.match(errors[0].message, /trailing comma before '\)'/i);
        manager.dispose();
      });

      it('T1.9: Trailing comma at end of query statement emits DiagnosticSeverity.Error', () => {
        const code = `con.sql("""SELECT id, email,""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1, 'Expected error for trailing comma at statement end');
        assert.match(errors[0].message, /trailing comma at end of query/i);
        manager.dispose();
      });

      it('T1.10: Valid list comma does not emit error', () => {
        const code = `con.sql("""SELECT id, email, name FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.strictEqual(errors.length, 0, 'Valid commas must not be flagged');
        manager.dispose();
      });
    });

    describe('3. Incomplete Clauses & Dangling Operators', () => {
      it('T1.11: Incomplete FROM clause missing table reference (SELECT * FROM WHERE)', () => {
        const code = `con.sql("""SELECT * FROM WHERE id = 1""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1, 'Expected error on incomplete FROM clause');
        assert.match(errors[0].message, /incomplete clause: 'FROM' missing table reference/i);
        manager.dispose();
      });

      it('T1.12: Incomplete SELECT clause missing expressions (SELECT FROM users)', () => {
        const code = `con.sql("""SELECT FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1);
        assert.match(errors[0].message, /incomplete clause: 'SELECT' missing expressions/i);
        manager.dispose();
      });

      it('T1.13: Incomplete WHERE clause at EOF or before clause boundary', () => {
        const code = `con.sql("""SELECT * FROM users WHERE""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1);
        assert.match(errors[0].message, /incomplete clause: 'WHERE' missing condition/i);
        manager.dispose();
      });

      it('T1.14: Incomplete GROUP BY / ORDER BY clause', () => {
        const code = `con.sql("""SELECT * FROM users GROUP BY""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1);
        assert.match(errors[0].message, /incomplete clause: 'GROUP BY' missing expressions/i);
        manager.dispose();
      });

      it('T1.15: Dangling binary operator (=) missing right operand', () => {
        const code = `con.sql("""SELECT * FROM users WHERE id = AND email = 'a@b.com'""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1);
        assert.match(errors[0].message, /dangling operator '=' missing operand/i);
        manager.dispose();
      });

      it('T1.16: Dangling logical operator (AND) at EOF', () => {
        const code = `con.sql("""SELECT * FROM users WHERE id = 1 AND""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1);
        assert.match(errors[0].message, /dangling operator 'AND' missing operand/i);
        manager.dispose();
      });

      it('T1.17: Dangling unary operator (NOT) missing condition', () => {
        const code = `con.sql("""SELECT * FROM users WHERE NOT AND id = 1""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1);
        assert.match(errors[0].message, /dangling operator 'NOT' missing condition/i);
        manager.dispose();
      });
    });

    describe('4. Unclosed Quotes', () => {
      it('T1.18: Unclosed single quote literal emits DiagnosticSeverity.Error', () => {
        const code = `con.sql("""SELECT * FROM users WHERE email = 'test@example.com""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1, 'Expected error for unclosed single quote');
        assert.match(errors[0].message, /unclosed string literal/i);
        manager.dispose();
      });

      it('T1.19: Unclosed double quote identifier emits DiagnosticSeverity.Error', () => {
        const code = `con.sql("""SELECT "user_email FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.ok(errors.length >= 1, 'Expected error for unclosed double quote');
        assert.match(errors[0].message, /unclosed quoted identifier/i);
        manager.dispose();
      });

      it('T1.20: SQL standard doubled single quote escaping (\'\') does not cause unclosed quote error', () => {
        const code = `con.sql("""SELECT * FROM users WHERE name = 'O''Reilly'""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.strictEqual(errors.length, 0, 'Doubled single quote must be recognized as escaped');
        manager.dispose();
      });

      it('T1.21: Backslash escaped quote (\\\' ) does not cause unclosed quote error', () => {
        const code = `con.sql("""SELECT * FROM users WHERE name = 'O\\'Reilly'""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        assert.strictEqual(errors.length, 0, 'Backslash escaped quote must be handled');
        manager.dispose();
      });
    });

    describe('5. Table Warnings against Catalog', () => {
      it('T1.22: Unknown table in FROM emits DiagnosticSeverity.Warning', () => {
        const code = `con.sql("""SELECT * FROM unknown_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 1, 'Expected 1 warning for nonexistent table');
        assert.match(warnings[0].message, /table 'unknown_table' does not exist in ducklake catalog/i);
        manager.dispose();
      });

      it('T1.23: Known catalog table in FROM emits zero warnings', () => {
        const code = `con.sql("""SELECT * FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Known table users must not emit warning');
        manager.dispose();
      });

      it('T1.24: Unknown table in JOIN clause emits DiagnosticSeverity.Warning', () => {
        const code = `con.sql("""SELECT * FROM users JOIN missing_orders ON users.id = missing_orders.user_id""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0].message, /table 'missing_orders' does not exist/i);
        manager.dispose();
      });

      it('T1.25: Built-in table functions (read_parquet, read_csv, range) are exempted from table warnings', () => {
        const code = `con.sql("""SELECT * FROM read_parquet('s3://bucket/data.parquet')""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Table functions must not trigger missing table warnings');
        manager.dispose();
      });

      it('T1.26: Subqueries in FROM / JOIN are exempted from missing table warnings', () => {
        const code = `con.sql("""SELECT * FROM (SELECT id FROM users) AS sub""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Subqueries must not trigger missing table warnings');
        manager.dispose();
      });
    });

    describe('6. Column Warnings against Table Schema', () => {
      it('T1.27: Qualified column reference on known table emits zero warnings if column exists', () => {
        const code = `con.sql("""SELECT users.email FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Known column users.email must not emit warning');
        manager.dispose();
      });

      it('T1.28: Qualified column reference on known table emits Warning if column does not exist', () => {
        const code = `con.sql("""SELECT users.invalid_col FROM users""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 1, 'Expected warning for invalid_col');
        assert.match(warnings[0].message, /column 'invalid_col' does not exist on table 'users'/i);
        manager.dispose();
      });

      it('T1.29: Qualified column reference on table alias resolves to base table and checks column', () => {
        const code = `con.sql("""SELECT u.fake_column FROM users u""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 1, 'Expected warning for u.fake_column');
        assert.match(warnings[0].message, /column 'fake_column' does not exist on table 'users'/i);
        manager.dispose();
      });

      it('T1.30: Wildcard qualified column reference (u.*) does not emit warning', () => {
        const code = `con.sql("""SELECT u.* FROM users u""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Wildcard column reference u.* is valid');
        manager.dispose();
      });
    });

    describe('7. CTE Handling', () => {
      it('T1.31: CTE defined in WITH clause is not flagged as missing table', () => {
        const code = `con.sql("""WITH cte AS (SELECT * FROM users) SELECT * FROM cte""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'CTE cte must be recognized and exempted from table warning');
        manager.dispose();
      });

      it('T1.32: Qualified column references on CTEs are exempted from column schema checking', () => {
        const code = `con.sql("""WITH cte AS (SELECT 1 AS num) SELECT cte.any_col FROM cte""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'CTE column references must not emit schema warnings');
        manager.dispose();
      });

      it('T1.33: Multiple CTEs defined with commas are all recognized', () => {
        const code = `con.sql("""WITH c1 AS (SELECT 1), c2 AS (SELECT 2) SELECT * FROM c1 JOIN c2 ON 1=1""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Both c1 and c2 CTEs must be recognized');
        manager.dispose();
      });

      it('T1.34: Recursive CTE (WITH RECURSIVE) is recognized and exempted', () => {
        const code = `con.sql("""WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt WHERE x<5) SELECT * FROM cnt""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Recursive CTE cnt must be exempted');
        manager.dispose();
      });
    });

    describe('8. Table Alias Handling', () => {
      it('T1.35: Table alias without AS is not flagged as missing table', () => {
        const code = `con.sql("""SELECT * FROM users u WHERE u.id = 1""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Alias u must not be flagged as missing table');
        manager.dispose();
      });

      it('T1.36: Table alias with AS is not flagged as missing table', () => {
        const code = `con.sql("""SELECT * FROM users AS usr WHERE usr.id = 1""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Alias usr must not be flagged as missing table');
        manager.dispose();
      });
    });

    describe('9. Disconnected/Empty Catalog Zero-False-Positive Rule', () => {
      it('T1.37: Disconnected catalog emits zero schema warnings on unknown tables and columns', () => {
        const code = `con.sql("""SELECT u.fake_col FROM unknown_table u""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager(standardTables, 'disconnected');
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Zero schema warnings allowed when catalog is disconnected');
        manager.dispose();
      });

      it('T1.38: Catalog in error state emits zero schema warnings', () => {
        const code = `con.sql("""SELECT * FROM ghost_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager(standardTables, 'error');
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Zero schema warnings when catalog is in error state');
        manager.dispose();
      });

      it('T1.39: Connected catalog with 0 tables emits zero schema warnings', () => {
        const code = `con.sql("""SELECT * FROM ghost_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager([], 'connected');
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.strictEqual(warnings.length, 0, 'Zero schema warnings when catalog has 0 tables');
        manager.dispose();
      });

      it('T1.40: Disconnected catalog still detects hard syntax errors', () => {
        const code = `con.sql("""SELECT (id FROM unknown_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager(standardTables, 'disconnected');
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.ok(errors.length >= 1, 'Syntax error must still be emitted');
        assert.strictEqual(warnings.length, 0, 'Schema warning must be suppressed');
        manager.dispose();
      });
    });

    describe('10. Debounce 300ms & Document Lifecycle', () => {
      it('T1.41: onDidChangeTextDocument triggers debounced validation after 300ms', async () => {
        const code = `con.sql("""SELECT * FROM unknown_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        // Fire text change event (typing simulation)
        mockVscode.workspace._emitDidChangeTextDocument({ document: doc });

        // Immediately after typing (0ms), collection should not have diagnostics yet
        const diagsImmediate = manager.getDiagnosticCollection().get(doc.uri);
        assert.strictEqual(diagsImmediate.length, 0, 'Diagnostics must not be set synchronously on edit');

        // Wait 350ms for debounce timer to fire
        await new Promise(r => setTimeout(r, 350));

        const diagsDebounced = manager.getDiagnosticCollection().get(doc.uri);
        assert.strictEqual(diagsDebounced.length, 1, 'Diagnostics must be populated after 300ms debounce');
        manager.dispose();
      });

      it('T1.42: Rapid typing resets debounce timer and executes only once after last change', async () => {
        const code1 = `con.sql("""SELECT * FROM""")`;
        const doc1 = createMockDocument(code1);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        // Keystroke 1
        mockVscode.workspace._emitDidChangeTextDocument({ document: doc1 });
        await new Promise(r => setTimeout(r, 100));

        // Keystroke 2 (before 300ms elapsed)
        mockVscode.workspace._emitDidChangeTextDocument({ document: doc1 });
        await new Promise(r => setTimeout(r, 100));

        // Keystroke 3
        mockVscode.workspace._emitDidChangeTextDocument({ document: doc1 });
        // At 200ms from keystroke 3 (total 400ms from keystroke 1), still not fired
        await new Promise(r => setTimeout(r, 150));
        assert.strictEqual(manager.getDiagnosticCollection().get(doc1.uri).length, 0);

        // Wait remaining time for keystroke 3 timer to complete
        await new Promise(r => setTimeout(r, 200));
        assert.ok(manager.getDiagnosticCollection().get(doc1.uri).length > 0);
        manager.dispose();
      });

      it('T1.43: onDidOpenTextDocument validates immediately (0ms debounce)', () => {
        const code = `con.sql("""SELECT * FROM unknown_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        mockVscode.workspace._emitOnDidOpenTextDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);
        assert.strictEqual(diags.length, 1, 'Opening document must validate immediately');
        manager.dispose();
      });

      it('T1.44: onDidSaveTextDocument validates immediately (0ms debounce)', () => {
        const code = `con.sql("""SELECT * FROM unknown_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        mockVscode.workspace._emitOnDidSaveTextDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);
        assert.strictEqual(diags.length, 1, 'Saving document must validate immediately');
        manager.dispose();
      });

      it('T1.45: Catalog schema change immediately re-evaluates open documents', () => {
        const code = `con.sql("""SELECT * FROM new_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        // Open document with unknown table 'new_table'
        mockVscode.workspace._emitOnDidOpenTextDocument(doc);
        assert.strictEqual(manager.getDiagnosticCollection().get(doc.uri).length, 1);

        // Catalog refreshes with new_table added
        const updatedTables = [
          ...standardTables,
          {
            schema: 'public',
            name: 'new_table',
            fullName: 'public.new_table',
            type: 'BASE TABLE',
            columns: []
          }
        ];
        schemaMgr._fireChange('connected', updatedTables);

        // Open documents are re-evaluated immediately; warning should now be 0
        const diagsAfter = manager.getDiagnosticCollection().get(doc.uri);
        assert.strictEqual(diagsAfter.length, 0, 'Schema refresh must clear warning for newly added table');
        manager.dispose();
      });

      it('T1.46: onDidCloseTextDocument clears diagnostics and cancels pending debounce timers', async () => {
        const code = `con.sql("""SELECT * FROM unknown_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        mockVscode.workspace._emitOnDidOpenTextDocument(doc);
        assert.strictEqual(manager.getDiagnosticCollection().get(doc.uri).length, 1);

        // Start a pending debounce timer
        mockVscode.workspace._emitDidChangeTextDocument({ document: doc });

        // Close document
        mockVscode.workspace._emitOnDidCloseTextDocument(doc);
        assert.strictEqual(manager.getDiagnosticCollection().get(doc.uri).length, 0, 'Closing document must clear diagnostics');

        // Wait to verify cancelled debounce timer does not resurrect diagnostics
        await new Promise(r => setTimeout(r, 350));
        assert.strictEqual(manager.getDiagnosticCollection().get(doc.uri).length, 0, 'Cancelled timer must not re-add diagnostics');
        manager.dispose();
      });
    });

    describe('11. Configuration Settings', () => {
      it('T1.47: ducklake.diagnostics.enable = false disables diagnostics and clears collection', () => {
        const code = `con.sql("""SELECT (id FROM unknown_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        manager.validateDocument(doc);
        assert.ok(manager.getDiagnosticCollection().get(doc.uri).length > 0);

        // Toggle setting to false
        setMockConfig('ducklake.diagnostics.enable', false);
        setMockConfig('diagnostics.enable', false);
        manager.handleConfigChange();

        assert.strictEqual(manager.getDiagnosticCollection().get(doc.uri).length, 0, 'Collection must be empty when diagnostics disabled');

        // Validating with disabled config does nothing
        manager.validateDocument(doc);
        assert.strictEqual(manager.getDiagnosticCollection().get(doc.uri).length, 0);
        manager.dispose();
      });

      it('T1.48: ducklake.diagnostics.checkSchema = false suppresses schema warnings but retains syntax errors', () => {
        const code = `con.sql("""SELECT (id, FROM unknown_table""")`;
        const doc = createMockDocument(code);
        const schemaMgr = createMockSchemaManager();
        const manager = new SqlDiagnosticsManager(schemaMgr);

        setMockConfig('ducklake.diagnostics.checkSchema', false);
        setMockConfig('diagnostics.checkSchema', false);

        manager.validateDocument(doc);
        const diags = manager.getDiagnosticCollection().get(doc.uri);

        const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
        const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
        assert.ok(errors.length >= 1, 'Syntax errors must still be checked');
        assert.strictEqual(warnings.length, 0, 'Schema warnings must be suppressed when checkSchema is false');
        manager.dispose();
      });
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY & CORNER CASES
  // =========================================================================
  describe('Tier 2: Boundary & Corner Cases', () => {
    it('T2.1: Empty SQL string and whitespace-only SQL produce zero errors and zero warnings', () => {
      const code = `con.sql("""   \n   \t  """)`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 0, 'Empty SQL blocks must produce 0 diagnostics');
      manager.dispose();
    });

    it('T2.2: Single-line comments (--) containing parentheses, commas, or keywords are ignored', () => {
      const code = `con.sql("""
SELECT id, email -- ( unclosed paren and trailing comma,
FROM users
""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 0, 'Comments must not introduce syntax errors');
      manager.dispose();
    });

    it('T2.3: Block comments (/* */) containing invalid SQL syntax are ignored', () => {
      const code = `con.sql("""
/* ( unclosed paren, trailing comma, FROM WHERE */
SELECT id, email FROM users
""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 0, 'Block comments must be masked out');
      manager.dispose();
    });

    it('T2.4: Thai table and column names in catalog are resolved cleanly', () => {
      const code = `con.sql("""SELECT c.รหัส, c.ชื่อ FROM ตารางลูกค้า c""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 0, 'Thai identifiers must be recognized cleanly');
      manager.dispose();
    });

    it('T2.5: Missing column on Thai table emits schema warning', () => {
      const code = `con.sql("""SELECT c.คอลัมน์ที่ไม่มี FROM ตารางลูกค้า c""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0].message, /column 'คอลัมน์ที่ไม่มี' does not exist on table 'ตารางลูกค้า'/i);
      manager.dispose();
    });

    it('T2.6: Nonexistent Thai table emits table warning', () => {
      const code = `con.sql("""SELECT * FROM ตารางที่ไม่มี""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0].message, /table 'ตารางที่ไม่มี' does not exist in ducklake catalog/i);
      manager.dispose();
    });

    it('T2.7: Deeply nested balanced parentheses pass without errors', () => {
      const code = `con.sql("""SELECT ((((1 + 2) * 3) + 4) * 5) AS val FROM users""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 0);
      manager.dispose();
    });

    it('T2.8: Deeply nested unbalanced parentheses identify exact unclosed token', () => {
      const code = `con.sql("""SELECT ((((1 + 2 * 3) + 4) * 5) AS val FROM users""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
      assert.strictEqual(errors.length, 1);
      assert.match(errors[0].message, /unclosed parenthesis/i);
      manager.dispose();
    });

    it('T2.9: Multiple chained CTEs (a -> b -> c) resolve without false warnings', () => {
      const code = `con.sql("""
WITH a AS (SELECT 1 AS x),
     b AS (SELECT x FROM a),
     c AS (SELECT x FROM b)
SELECT * FROM c
""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 0);
      manager.dispose();
    });

    it('T2.10: Multiple SQL blocks in one Python document are each validated independently with exact ranges', () => {
      const code = `import duckdb
con = duckdb.connect()

# Block 1: Valid
q1 = con.sql("""SELECT id, email FROM users""")

# Block 2: Syntax error (trailing comma)
q2 = con.sql("""SELECT id, email, FROM users""")

# Block 3: Schema warning (unknown table)
q3 = con.sql("""SELECT * FROM non_existent_log""")
`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);

      const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
      const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);

      assert.strictEqual(errors.length, 1, 'Block 2 should emit 1 syntax error');
      assert.strictEqual(warnings.length, 1, 'Block 3 should emit 1 schema warning');

      // Check that Block 2 error is positioned on line 7
      assert.strictEqual(errors[0].range.start.line, 7);
      // Check that Block 3 warning is positioned on line 10
      assert.strictEqual(warnings[0].range.start.line, 10);
      manager.dispose();
    });

    it('T2.11: Jupyter Notebook cell document URI (vscode-notebook-cell) is supported', () => {
      const code = `con.sql("""SELECT * FROM non_existent_dataset""")`;
      const doc = createMockDocument(code, 'vscode-notebook-cell:/c:/Users/notebook.ipynb#ch001');
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 1);
      assert.strictEqual(doc.uri.scheme, 'vscode-notebook-cell');
      manager.dispose();
    });
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE COMBINATIONS
  // =========================================================================
  describe('Tier 3: Cross-Feature Combinations', () => {
    it('T3.1: CTE with table alias and qualified column access emits zero warnings', () => {
      const code = `con.sql("""
WITH user_summary AS (
    SELECT id, count(*) as cnt
    FROM users
    GROUP BY id
)
SELECT s.cnt
FROM user_summary s
""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 0, 'CTE alias with qualified column must be accepted without warnings');
      manager.dispose();
    });

    it('T3.2: Syntax error inside CTE definition is reported accurately', () => {
      const code = `con.sql("""
WITH bad_cte AS (
    SELECT id, email,
    FROM users
)
SELECT * FROM bad_cte
""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);

      const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
      assert.ok(errors.length >= 1, 'Trailing comma inside CTE must be flagged');
      assert.match(errors[0].message, /trailing comma before 'FROM'/i);
      manager.dispose();
    });

    it('T3.3: Query with valid syntax but nonexistent table emits 0 Errors and exactly 1 Warning', () => {
      const code = `con.sql("""SELECT a, b, c FROM phantom_table WHERE a > 10""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);

      const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
      const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);

      assert.strictEqual(errors.length, 0, 'Syntax is completely valid');
      assert.strictEqual(warnings.length, 1, 'Exactly 1 warning for phantom_table');
      manager.dispose();
    });

    it('T3.4: Disconnected catalog with syntax error flags syntax error but suppresses all schema warnings', () => {
      const code = `con.sql("""SELECT (a + b FROM phantom_table""")`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager(standardTables, 'disconnected');
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);

      const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
      const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);

      assert.strictEqual(errors.length, 1, 'Syntax error must be flagged even when disconnected');
      assert.strictEqual(warnings.length, 0, 'Schema warning for phantom_table must be suppressed');
      manager.dispose();
    });
  });

  // =========================================================================
  // TIER 4: REAL-WORLD PYTHON SCRIPTS & JUPYTER NOTEBOOKS
  // =========================================================================
  describe('Tier 4: Real-world Python Scripts & Jupyter Notebooks', () => {
    it('T4.1: Real-world DuckDB ETL Python script with window functions, joins, and CTEs passes with zero diagnostics', () => {
      const script = `
import duckdb
import pandas as pd

con = duckdb.connect()

# 1. Pipeline preparation
etl_query = con.sql("""
WITH ranked_orders AS (
    SELECT
        user_id,
        order_id,
        total_amount,
        row_number() OVER (PARTITION BY user_id ORDER BY total_amount DESC) as rn,
        dense_rank() OVER (PARTITION BY user_id ORDER BY total_amount DESC) as drk
    FROM orders
    WHERE status = 'completed'
)
SELECT
    u.id,
    u.email,
    ro.order_id,
    ro.total_amount
FROM users u
JOIN ranked_orders ro ON u.id = ro.user_id
WHERE ro.rn = 1
ORDER BY ro.total_amount DESC
""")

print("ETL complete")
`;
      const doc = createMockDocument(script);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 0, 'Clean ETL script should produce zero diagnostics');
      manager.dispose();
    });

    it('T4.2: Real-world Jupyter notebook workflow with DuckLake lakehouse ATTACH queries passes cleanly', () => {
      const notebookCell = `
# In [4]: Connect to DuckLake catalog and inspect sales
import duckdb
con = duckdb.connect()

con.sql("""
ATTACH 'ducklake:postgres:host=127.0.0.1 dbname=ducklake_e2e' AS lake;
""")

result = con.sql("""
SELECT
    u.id,
    u.email,
    o.order_id,
    o.total_amount
FROM lake.public.users u
JOIN lake.public.orders o ON u.id = o.user_id
WHERE o.total_amount > 500
""").df()
`;
      const doc = createMockDocument(notebookCell, 'vscode-notebook-cell:/c:/workspace/lakehouse.ipynb#c02');
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(diags.length, 0, 'Valid notebook lakehouse queries should produce zero diagnostics');
      manager.dispose();
    });

    it('T4.3: Mixed error document contains both syntax Error and schema Warning with distinct lines', () => {
      const code = `
import duckdb
con = duckdb.connect()

# Developer typo: trailing comma in column list, plus querying invalid table
df = con.sql("""
SELECT
    id,
    email,
FROM non_existent_audit_log
WHERE id > 100
""")
`;
      const doc = createMockDocument(code);
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      manager.validateDocument(doc);
      const diags = manager.getDiagnosticCollection().get(doc.uri);

      const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
      const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);

      assert.strictEqual(errors.length, 1, 'Should report trailing comma syntax error');
      assert.strictEqual(warnings.length, 1, 'Should report non_existent_audit_log table warning');

      // Error on line 8 (email,)
      assert.strictEqual(errors[0].range.start.line, 8);
      // Warning on line 9 (non_existent_audit_log)
      assert.strictEqual(warnings[0].range.start.line, 9);
      manager.dispose();
    });

    it('T4.4: Interactive document editing lifecycle simulation: broken -> typing -> fixed -> closed', async () => {
      // Step 1: Open document with broken syntax
      const brokenCode = `con.sql("""SELECT (id FROM users""")`;
      const doc = createMockDocument(brokenCode, 'c:/project/interactive.py');
      const schemaMgr = createMockSchemaManager();
      const manager = new SqlDiagnosticsManager(schemaMgr);

      mockVscode.workspace._emitOnDidOpenTextDocument(doc);
      const initialDiags = manager.getDiagnosticCollection().get(doc.uri);
      assert.strictEqual(initialDiags.length, 1, 'Initial broken document has 1 error');

      // Step 2: User edits document to fix typo
      const fixedCode = `con.sql("""SELECT id FROM users""")`;
      const fixedDoc = createMockDocument(fixedCode, 'c:/project/interactive.py');

      // Fire typing change event
      mockVscode.workspace._emitDidChangeTextDocument({ document: fixedDoc });

      // Before debounce fires (0ms), diagnostics still present
      assert.strictEqual(manager.getDiagnosticCollection().get(fixedDoc.uri).length, 1);

      // Wait 350ms for debounce timer to fire
      await new Promise(r => setTimeout(r, 350));

      const fixedDiags = manager.getDiagnosticCollection().get(fixedDoc.uri);
      assert.strictEqual(fixedDiags.length, 0, 'Fixed document must have 0 diagnostics');

      // Step 3: User closes document
      mockVscode.workspace._emitOnDidCloseTextDocument(fixedDoc);
      assert.strictEqual(manager.getDiagnosticCollection().get(fixedDoc.uri).length, 0);
      assert.strictEqual(manager.getDiagnosticCollection().has(fixedDoc.uri), false);

      manager.dispose();
    });
  });
});
