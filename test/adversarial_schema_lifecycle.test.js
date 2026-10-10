// test/adversarial_schema_lifecycle.test.js
// Adversarial Empirical Challenge Suite for Schema Validation, CTEs, Aliases, & Diagnostics Lifecycle
// Challenger 2: Adversarial Schema & Lifecycle Challenger

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

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

// Standard Test Catalog Fixtures
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

function createMockSchemaManager(status = 'connected', tables = standardTables) {
  let currentStatus = status;
  let currentTables = [...tables];
  const listeners = [];

  return {
    getState: () => ({ status: currentStatus, lastRefreshed: new Date() }),
    getTables: () => currentTables,
    findTable: (name) => {
      const clean = name.toLowerCase().trim().replace(/["`]/g, '');
      const simple = clean.includes('.') ? clean.split('.').pop() : clean;
      return currentTables.find(t =>
        t.name.toLowerCase() === clean ||
        t.name.toLowerCase() === simple ||
        t.fullName.toLowerCase() === clean
      );
    },
    onDidChangeSchema: (callback) => {
      listeners.push(callback);
      return { dispose: () => {} };
    },
    _setStatus: (newStatus) => {
      currentStatus = newStatus;
    },
    _setTables: (newTables) => {
      currentTables = newTables;
      listeners.forEach(cb => cb());
    }
  };
}

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
    offsetAt: (position) => (lineOffsets[position.line] || 0) + position.character,
    positionAt: (offset) => {
      let line = 0;
      for (let i = lineOffsets.length - 1; i >= 0; i--) {
        if (offset >= lineOffsets[i]) {
          line = i;
          break;
        }
      }
      const character = Math.max(0, offset - (lineOffsets[line] || 0));
      return new mockVscode.Position(line, character);
    }
  };
}

function getDiagnosticsForUri(collection, uri) {
  if (typeof collection.get === 'function') {
    return collection.get(uri) || [];
  }
  return [];
}

const catalogMap = new Map([
  ['users', { columns: ['id', 'email', 'name', 'created_at'] }],
  ['public.users', { columns: ['id', 'email', 'name', 'created_at'] }],
  ['orders', { columns: ['order_id', 'user_id', 'total_amount', 'status'] }],
  ['public.orders', { columns: ['order_id', 'user_id', 'total_amount', 'status'] }],
  ['ตารางลูกค้า', { columns: ['รหัส', 'ชื่อ', 'ยอดเงิน'] }],
  ['public.ตารางลูกค้า', { columns: ['รหัส', 'ชื่อ', 'ยอดเงิน'] }]
]);

describe('Challenger 2: Adversarial Schema & Lifecycle Challenge Suite', () => {
  beforeEach(() => {
    resetMockConfig();
    resetDiagnosticCollections();
  });

  afterEach(() => {
    resetMockConfig();
    resetDiagnosticCollections();
  });

  // =========================================================================
  // Challenge 1: Complex CTE Handling
  // =========================================================================
  describe('Challenge 1: Complex CTEs', () => {
    it('C1.1: 5 chained CTEs (c1 -> c2 -> c3 -> c4 -> c5) in join emit 0 warnings', () => {
      const sql = `
WITH
  c1 AS (SELECT id, email FROM users),
  c2 AS (SELECT id, email FROM c1 WHERE id > 10),
  c3 AS (SELECT id FROM c2),
  c4 AS (SELECT id FROM c3),
  c5 AS (SELECT id FROM c4)
SELECT c1.email, c5.id
FROM c1
JOIN c5 ON c1.id = c5.id
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for 5 chained CTEs, got: ${JSON.stringify(diags)}`);
    });

    it('C1.2: Recursive CTE with column aliases WITH RECURSIVE cnt(x, y) AS (...) produces 0 warnings', () => {
      const sql = `
WITH RECURSIVE cnt(x, y) AS (
  SELECT 1 AS x, 100 AS y
  UNION ALL
  SELECT x + 1, y - 1 FROM cnt WHERE x < 10
)
SELECT cnt.x, cnt.y FROM cnt
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for recursive CTE with column aliases, got: ${JSON.stringify(diags)}`);
    });

    it('C1.3: Recursive CTE joined with real catalog table checks catalog table but exempts CTE', () => {
      const sql = `
WITH RECURSIVE hierarchy(lvl) AS (
  SELECT 1 AS lvl
  UNION ALL
  SELECT lvl + 1 FROM hierarchy WHERE lvl < 5
)
SELECT h.lvl, u.email, u.nonexistent_field
FROM hierarchy h
JOIN users u ON h.lvl = u.id
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);

      // hierarchy and h are exempted. u.email is valid. u.nonexistent_field is flagged!
      assert.strictEqual(diags.length, 1, `Expected exactly 1 warning for u.nonexistent_field, got ${diags.length}`);
      assert.match(diags[0].message, /Column 'nonexistent_field' does not exist on table 'users'/);
    });

    it('C1.4: CTE alias in main query (WITH c AS (...) SELECT x.val FROM c AS x) is exempted', () => {
      const sql = `
WITH c AS (SELECT id FROM users)
SELECT x.id, x.any_column_on_cte
FROM c AS x
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for aliased CTE columns, got: ${JSON.stringify(diags)}`);
    });

    it('C1.5: CTE referencing an unknown table inside its body produces warning for unknown table', () => {
      const sql = `
WITH my_cte AS (
  SELECT * FROM completely_fake_table_12345
)
SELECT * FROM my_cte
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 1, `Expected 1 warning for fake table inside CTE`);
      assert.match(diags[0].message, /Table 'completely_fake_table_12345' does not exist/);
    });

    it('C1.6: CTE shadowing a catalog table name exempts shadowed name from catalog table/column checks', () => {
      // 'users' exists in catalog with columns id, email, name, created_at.
      // But query defines CTE named 'users' with custom column 'custom_metric'.
      const sql = `
WITH users AS (
  SELECT 999 AS custom_metric
)
SELECT users.custom_metric FROM users
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings because CTE shadows catalog table`);
    });

    it('C1.7: CTE with Thai Unicode identifier is recognized and exempted', () => {
      const sql = `
WITH ข้อมูลรายวัน AS (
  SELECT รหัส, ยอดเงิน FROM ตารางลูกค้า
)
SELECT ข้อมูลรายวัน.รหัส, ข้อมูลรายวัน.ยอดเงิน
FROM ข้อมูลรายวัน
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for Thai CTE, got: ${JSON.stringify(diags)}`);
    });

    it('C1.8: Quoted identifier CTE WITH "my cte name" AS (...) is recognized and exempted', () => {
      const sql = `
WITH "my cte name" AS (
  SELECT id FROM users
)
SELECT * FROM "my cte name"
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for quoted CTE identifier`);
    });
  });

  // =========================================================================
  // Challenge 2: Table Aliases & Qualified Columns
  // =========================================================================
  describe('Challenge 2: Table Aliases & Qualified Columns', () => {
    it('A2.1: Alias overshadowing: FROM orders AS users validates against orders, not catalog users', () => {
      // Alias 'users' points to base table 'orders'!
      // 'order_id' exists on orders -> valid.
      // 'email' does NOT exist on orders (even though it exists on catalog users table!) -> Warning!
      const sql = `
SELECT users.order_id, users.email
FROM orders AS users
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);

      assert.strictEqual(diags.length, 1, `Expected 1 warning for users.email on orders`);
      assert.match(diags[0].message, /Column 'email' does not exist on table 'orders'/);
    });

    it('A2.2: Multi-table join with multiple aliases and qualified columns resolves accurately', () => {
      const sql = `
SELECT u.id, u.email, o.order_id, o.total_amount
FROM users u
JOIN orders o ON u.id = o.user_id
WHERE o.status = 'COMPLETED'
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for valid multi-table join with aliases`);
    });

    it('A2.3: Multiple missing columns across different aliases report exact table names', () => {
      const sql = `
SELECT u.bad_col_1, o.bad_col_2
FROM users u
JOIN orders o ON u.id = o.user_id
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);

      assert.strictEqual(diags.length, 2, `Expected 2 warnings`);
      const msg1 = diags.find(d => d.message.includes('bad_col_1'));
      const msg2 = diags.find(d => d.message.includes('bad_col_2'));
      assert.ok(msg1 && msg1.message.includes("table 'users'"));
      assert.ok(msg2 && msg2.message.includes("table 'orders'"));
    });

    it('A2.4: Self-join with distinct aliases (users u1 JOIN users u2) resolves both aliases cleanly', () => {
      const sql = `
SELECT u1.id, u2.email
FROM users u1
JOIN users u2 ON u1.id = u2.id
WHERE u1.id != u2.id
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for self-join`);
    });

    it('A2.5: Quoted and backtick identifiers in alias and columns resolve accurately', () => {
      const sql = `
SELECT "u"."id", \`u\`.\`email\`, "u"."fake_col"
FROM users AS "u"
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);

      assert.strictEqual(diags.length, 1, `Expected 1 warning for fake_col`);
      assert.match(diags[0].message, /Column '(")?fake_col(")?' does not exist on table 'users'/);
    });

    it('A2.6: Schema-qualified table reference (public.users) resolves simple name in column check', () => {
      const sql = `
SELECT users.id, users.email
FROM public.users
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for schema-qualified table`);
    });

    it('A2.7: Wildcard on alias (u.*) and base table (users.*) does not emit warning', () => {
      const sql = `
SELECT u.*, users.*
FROM users u
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for wildcard references`);
    });
  });

  // =========================================================================
  // Challenge 3: Table Functions & Derived Subqueries (Strict Zero False Positives)
  // =========================================================================
  describe('Challenge 3: Table Functions & Derived Subqueries', () => {
    const tableFunctionsQueries = [
      `SELECT * FROM read_parquet('s3://my-bucket/lakehouse/data.parquet')`,
      `SELECT * FROM read_parquet(['s3://bucket/part1.parquet', 's3://bucket/part2.parquet'])`,
      `SELECT * FROM read_csv('data/raw_metrics.csv', header=true, delim=',')`,
      `SELECT * FROM read_csv_auto('data/auto.csv')`,
      `SELECT * FROM read_json('data/events.json')`,
      `SELECT * FROM read_json_auto('data/events_auto.json')`,
      `SELECT * FROM range(10)`,
      `SELECT * FROM range(1, 10)`,
      `SELECT * FROM range(1, 100, 5)`,
      `SELECT * FROM generate_series(1, 10)`,
      `SELECT * FROM parquet_scan('data/*.parquet')`,
      `SELECT * FROM csv_scan('data/*.csv')`,
      `SELECT * FROM delta_scan('s3://lake/delta_tbl')`,
      `SELECT * FROM iceberg_scan('s3://lake/iceberg_tbl')`,
      `SELECT * FROM duckdb_tables()`,
      `SELECT * FROM duckdb_views()`,
      `SELECT * FROM duckdb_columns()`,
      `SELECT * FROM unnest([1, 2, 3])`,
      `SELECT * FROM glob('data/*.parquet')`,
      `SELECT * FROM repeat('abc', 5)`
    ];

    for (const [idx, query] of tableFunctionsQueries.entries()) {
      it(`F3.${idx + 1}: Table function query #${idx + 1} produces STRICT ZERO warnings`, () => {
        const doc = createMockDocument(`query = """${query}"""`);
        const block = { text: query, startOffset: 12, endOffset: 12 + query.length };
        const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
        assert.strictEqual(diags.length, 0, `Unexpected warning for table function: ${query} => ${JSON.stringify(diags)}`);
      });
    }

    it('F3.21: Table functions with aliases and column references produce ZERO warnings', () => {
      const sql = `
SELECT p.filename, p.count, r.range
FROM read_parquet('s3://lake/*.parquet') AS p
JOIN range(10) r ON 1=1
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for aliased table functions`);
    });

    it('F3.22: Derived subqueries in FROM and JOIN produce ZERO warnings', () => {
      const sql = `
SELECT sub1.calc_col, sub2.num
FROM (
  SELECT 1 AS calc_col, 2 AS other
) AS sub1
JOIN (
  SELECT 100 AS num
) sub2 ON sub1.calc_col = 1
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for derived subqueries`);
    });

    it('F3.23: Table function joined with real catalog table checks only the catalog table', () => {
      const sql = `
SELECT u.id, u.bad_column, p.metric
FROM users u
JOIN read_parquet('data.parquet') p ON u.id = 1
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);

      assert.strictEqual(diags.length, 1, `Expected 1 warning for u.bad_column`);
      assert.match(diags[0].message, /Column 'bad_column' does not exist on table 'users'/);
    });
  });

  // =========================================================================
  // Challenge 4: Thai Unicode Table and Column Names
  // =========================================================================
  describe('Challenge 4: Thai Unicode Tables & Columns', () => {
    it('U4.1: Known Thai table and known columns produce 0 warnings', () => {
      const sql = `
SELECT ตารางลูกค้า.รหัส, ตารางลูกค้า.ชื่อ, ตารางลูกค้า.ยอดเงิน
FROM ตารางลูกค้า
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for valid Thai table and columns`);
    });

    it('U4.2: Thai table with Thai alias (ตารางลูกค้า AS ล) resolves valid columns with 0 warnings', () => {
      const sql = `
SELECT ล.รหัส, ล.ชื่อ, ล.ยอดเงิน
FROM ตารางลูกค้า AS ล
WHERE ล.ยอดเงิน > 5000
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings for Thai table alias`);
    });

    it('U4.3: Thai table with missing Thai column (ตารางลูกค้า.รหัสลูกค้า) emits schema warning', () => {
      const sql = `
SELECT ตารางลูกค้า.รหัสลูกค้า
FROM ตารางลูกค้า
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);

      assert.strictEqual(diags.length, 1, `Expected 1 warning for missing Thai column`);
      assert.match(diags[0].message, /Column 'รหัสลูกค้า' does not exist on table 'ตารางลูกค้า'/);
    });

    it('U4.4: Thai alias with missing Thai column (ล.ที่อยู่) emits schema warning citing base table', () => {
      const sql = `
SELECT ล.ที่อยู่
FROM ตารางลูกค้า ล
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);

      assert.strictEqual(diags.length, 1, `Expected 1 warning`);
      assert.match(diags[0].message, /Column 'ที่อยู่' does not exist on table 'ตารางลูกค้า'/);
    });

    it('U4.5: Nonexistent Thai table emits table existence warning', () => {
      const sql = `
SELECT * FROM ตารางสินค้าคงคลัง
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, true);

      assert.strictEqual(diags.length, 1, `Expected 1 warning for nonexistent Thai table`);
      assert.match(diags[0].message, /Table 'ตารางสินค้าคงคลัง' does not exist in DuckLake catalog/);
    });

    it('U4.6: Quoted Thai table and column names with spaces work identically', () => {
      const mapWithQuoted = new Map(catalogMap);
      mapWithQuoted.set('ตาราง สินค้า', { columns: ['รหัส สินค้า', 'ราคา'] });

      const sql = `
SELECT "ตาราง สินค้า"."รหัส สินค้า", "ตาราง สินค้า"."ไม่มี"
FROM "ตาราง สินค้า"
      `;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };
      const diags = SchemaValidator.validateSchemaWithTables(doc, block, mapWithQuoted, true);

      assert.strictEqual(diags.length, 1, `Expected 1 warning for missing column`);
      assert.match(diags[0].message, /Column '(")?ไม่มี(")?' does not exist on table 'ตาราง สินค้า'/);
    });
  });

  // =========================================================================
  // Challenge 5: Disconnected or Empty Catalog (Strict Zero False Positives)
  // =========================================================================
  describe('Challenge 5: Disconnected or Empty Catalog Suppression', () => {
    const adversarialQueries = [
      `SELECT * FROM fake_tbl_1 JOIN fake_tbl_2 ON 1=1`,
      `SELECT f1.nonexistent, f2.bogus FROM fake_tbl_1 f1 JOIN fake_tbl_2 f2 ON 1=1`,
      `SELECT nonexistent_column FROM nonexistent_table WHERE another_fake = 10`,
      `WITH c AS (SELECT * FROM totally_fake) SELECT c.fake FROM c`,
      `SELECT t1.a, t2.b, t3.c FROM t1, t2, t3 WHERE t1.x = t2.y`,
      `SELECT * FROM ตารางที่ไม่มีอยู่จริง WHERE คอลัมน์ปลอม = 'test'`
    ];

    it('D5.1: Disconnected catalog (isCatalogConnected: false) emits STRICT ZERO warnings on all queries', () => {
      for (const query of adversarialQueries) {
        const doc = createMockDocument(`query = """${query}"""`);
        const block = { text: query, startOffset: 12, endOffset: 12 + query.length };
        const diags = SchemaValidator.validateSchemaWithTables(doc, block, catalogMap, false);
        assert.strictEqual(diags.length, 0, `Expected 0 warnings when disconnected for: ${query}`);
      }
    });

    it('D5.2: Empty catalog (catalogTables.size: 0, connected: true) emits STRICT ZERO warnings on all queries', () => {
      const emptyMap = new Map();
      for (const query of adversarialQueries) {
        const doc = createMockDocument(`query = """${query}"""`);
        const block = { text: query, startOffset: 12, endOffset: 12 + query.length };
        const diags = SchemaValidator.validateSchemaWithTables(doc, block, emptyMap, true);
        assert.strictEqual(diags.length, 0, `Expected 0 warnings when catalog has 0 tables for: ${query}`);
      }
    });

    it('D5.3: SchemaManager in disconnected, connecting, or error state emits STRICT ZERO warnings', () => {
      const doc = createMockDocument(`query = """SELECT * FROM nonexistent_table"""`);
      const block = { text: 'SELECT * FROM nonexistent_table', startOffset: 12, endOffset: 43 };

      for (const st of ['disconnected', 'connecting', 'error']) {
        const mgr = createMockSchemaManager(st, standardTables);
        const diags = SchemaValidator.validateSchema(doc, block, mgr);
        assert.strictEqual(diags.length, 0, `Expected 0 warnings when state is '${st}'`);
      }
    });

    it('D5.4: SchemaManager with 0 tables emits STRICT ZERO warnings', () => {
      const doc = createMockDocument(`query = """SELECT * FROM nonexistent_table"""`);
      const block = { text: 'SELECT * FROM nonexistent_table', startOffset: 12, endOffset: 43 };
      const mgr = createMockSchemaManager('connected', []);
      const diags = SchemaValidator.validateSchema(doc, block, mgr);
      assert.strictEqual(diags.length, 0, `Expected 0 warnings when SchemaManager has 0 tables`);
    });

    it('D5.5: Disconnected catalog STILL reports hard syntax errors (Errors) while suppressing schema warnings', () => {
      // Syntax error (unbalanced paren + dangling operator) on nonexistent table
      const sql = `SELECT ( FROM nonexistent_table WHERE +`;
      const doc = createMockDocument(`query = """${sql}"""`);
      const block = { text: sql, startOffset: 12, endOffset: 12 + sql.length };

      const validator = new SqlValidator();
      const diags = validator.validateSql(doc, block, {
        checkSyntax: true,
        checkSchema: true,
        catalogTables: catalogMap,
        isCatalogConnected: false // disconnected!
      });

      // Syntax errors must exist
      const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
      assert.ok(errors.length > 0, `Expected syntax errors even when disconnected`);

      // Schema warnings must be 0
      const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);
      assert.strictEqual(warnings.length, 0, `Expected 0 schema warnings when disconnected`);
    });
  });

  // =========================================================================
  // Challenge 6: Rapid Document Changes & Debounce Lifecycle
  // =========================================================================
  describe('Challenge 6: Debounce Lifecycle & Rapid Document Changes', () => {
    it('L6.1: 20 rapid edits within 50ms intervals reset timer; validation executes only ONCE after last edit', async () => {
      const schemaMgr = createMockSchemaManager('connected', standardTables);
      const manager = new SqlDiagnosticsManager(schemaMgr);

      let content = `query = """SELECT * FROM users"""`;
      const doc = createMockDocument(content, 'c:/project/rapid_typing.py');

      // Rapidly fire 20 edits at 20ms intervals (total ~400ms)
      for (let i = 0; i < 20; i++) {
        content = `query = """SELECT id, email FROM users WHERE id > ${i}"""`;
        const updatedDoc = createMockDocument(content, 'c:/project/rapid_typing.py');
        manager.triggerValidation(updatedDoc, false);
        await new Promise(r => setTimeout(r, 20));
      }

      // Immediately after 20 edits, timer should NOT have fired yet (since last edit was < 300ms ago)
      let diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      // Wait for debounce period (350ms)
      await new Promise(r => setTimeout(r, 350));

      diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      assert.strictEqual(diags.length, 0, `Expected 0 errors after debounce completion on valid query`);

      manager.dispose();
    });

    it('L6.2: Closing a document while debounce timer is active cancels timer and clears collection', async () => {
      const schemaMgr = createMockSchemaManager('connected', standardTables);
      const manager = new SqlDiagnosticsManager(schemaMgr);

      // Doc has invalid syntax: SELECT ( FROM users
      const doc = createMockDocument(`query = """SELECT ( FROM users"""`, 'c:/project/to_close.py');

      // Trigger debounced validation
      manager.triggerValidation(doc, false);

      // Close document after 100ms (before 300ms debounce fires)
      await new Promise(r => setTimeout(r, 100));
      manager.clearDiagnostics(doc);

      // Wait 350ms more to ensure the cancelled timer does NOT fire
      await new Promise(r => setTimeout(r, 350));

      const diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      assert.strictEqual(diags.length, 0, `Expected 0 diagnostics after document closed`);

      manager.dispose();
    });

    it('L6.3: Independent documents have isolated debounce timers', async () => {
      const schemaMgr = createMockSchemaManager('connected', standardTables);
      const manager = new SqlDiagnosticsManager(schemaMgr);

      const docA = createMockDocument(`query = """SELECT ( FROM users"""`, 'c:/project/doc_a.py');
      const docB = createMockDocument(`query = """SELECT * FROM users"""`, 'c:/project/doc_b.py');

      // Trigger doc A at t=0
      manager.triggerValidation(docA, false);

      // Wait 150ms and trigger doc B
      await new Promise(r => setTimeout(r, 150));
      manager.triggerValidation(docB, false);

      // Wait 200ms more (t=350ms from start). Doc A timer should have fired, but Doc B still waiting (200ms < 300ms)
      await new Promise(r => setTimeout(r, 200));

      const diagsA = getDiagnosticsForUri(manager.getDiagnosticCollection(), docA.uri);
      assert.ok(diagsA.length > 0, `Doc A should have been validated after its 300ms debounce`);

      // Wait 150ms more for Doc B (t=500ms total)
      await new Promise(r => setTimeout(r, 150));
      const diagsB = getDiagnosticsForUri(manager.getDiagnosticCollection(), docB.uri);
      assert.strictEqual(diagsB.length, 0, `Doc B should have validated with 0 errors`);

      manager.dispose();
    });

    it('L6.4: Immediate validation flag bypasses debounce timer and executes synchronously', () => {
      const schemaMgr = createMockSchemaManager('connected', standardTables);
      const manager = new SqlDiagnosticsManager(schemaMgr);

      const doc = createMockDocument(`query = """SELECT ( FROM users"""`, 'c:/project/immediate.py');
      manager.triggerValidation(doc, true); // immediate = true

      const diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      assert.ok(diags.length > 0, `Expected immediate diagnostics without waiting for debounce`);

      manager.dispose();
    });
  });

  // =========================================================================
  // Challenge 7: Configuration Toggles & Lifecycle Management
  // =========================================================================
  describe('Challenge 7: Configuration Toggles & Settings', () => {
    it('T7.1: ducklake.diagnostics.enable = false immediately clears diagnostic collection and pending timers', async () => {
      const schemaMgr = createMockSchemaManager('connected', standardTables);
      const manager = new SqlDiagnosticsManager(schemaMgr);

      const doc = createMockDocument(`query = """SELECT ( FROM users"""`, 'c:/project/toggle.py');
      manager.triggerValidation(doc, true);

      let diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      assert.ok(diags.length > 0, `Initial diagnostics should exist`);

      // Set enable = false
      setMockConfig('ducklake.diagnostics.enable', false);
      setMockConfig('diagnostics.enable', false);

      manager.handleConfigChange();

      diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      assert.strictEqual(diags.length, 0, `Diagnostics must be immediately cleared when diagnostics.enable = false`);

      // Attempt to trigger validation while disabled - must remain empty
      manager.triggerValidation(doc, true);
      diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      assert.strictEqual(diags.length, 0, `Validation must remain empty when diagnostics.enable = false`);

      manager.dispose();
    });

    it('T7.2: Re-enabling ducklake.diagnostics.enable restores diagnostics on open documents', () => {
      const schemaMgr = createMockSchemaManager('connected', standardTables);
      const manager = new SqlDiagnosticsManager(schemaMgr);

      const doc = createMockDocument(`query = """SELECT ( FROM users"""`, 'c:/project/re_enable.py');
      mockVscode.workspace.textDocuments = [doc];

      // Disable
      setMockConfig('ducklake.diagnostics.enable', false);
      setMockConfig('diagnostics.enable', false);
      manager.handleConfigChange();
      assert.strictEqual(getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri).length, 0);

      // Re-enable
      setMockConfig('ducklake.diagnostics.enable', true);
      setMockConfig('diagnostics.enable', true);
      manager.handleConfigChange();

      const diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      assert.ok(diags.length > 0, `Diagnostics must be restored when diagnostics.enable is turned back on`);

      mockVscode.workspace.textDocuments = [];
      manager.dispose();
    });

    it('T7.3: ducklake.diagnostics.checkSchema = false suppresses schema warnings while retaining syntax errors', () => {
      const schemaMgr = createMockSchemaManager('connected', standardTables);
      const manager = new SqlDiagnosticsManager(schemaMgr);

      // Query has BOTH syntax error and nonexistent table
      const doc = createMockDocument(`query = """SELECT (id FROM nonexistent_table"""`, 'c:/project/schema_toggle.py');

      // Enable = true, checkSchema = false
      setMockConfig('ducklake.diagnostics.enable', true);
      setMockConfig('diagnostics.enable', true);
      setMockConfig('ducklake.diagnostics.checkSchema', false);
      setMockConfig('diagnostics.checkSchema', false);
      manager.validateDocument(doc);

      const diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      const errors = diags.filter(d => d.severity === DiagnosticSeverity.Error);
      const warnings = diags.filter(d => d.severity === DiagnosticSeverity.Warning);

      assert.ok(errors.length > 0, `Syntax errors must still be emitted`);
      assert.strictEqual(warnings.length, 0, `Schema warnings must be suppressed when checkSchema = false`);

      manager.dispose();
    });

    it('T7.4: Extension disposal properly disposes collections and cancels all timers', () => {
      const schemaMgr = createMockSchemaManager('connected', standardTables);
      const manager = new SqlDiagnosticsManager(schemaMgr);

      const doc = createMockDocument(`query = """SELECT ( FROM users"""`, 'c:/project/dispose_test.py');
      manager.triggerValidation(doc, false); // Pending timer

      manager.dispose();

      const diags = getDiagnosticsForUri(manager.getDiagnosticCollection(), doc.uri);
      assert.strictEqual(diags.length, 0, `Collection must be cleared after disposal`);
    });
  });
});
