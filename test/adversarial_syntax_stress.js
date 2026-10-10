// test/adversarial_syntax_stress.js
// Empirical Stress Harness & Adversarial Challenge Suite for SqlValidator
// Author: Challenger 1 (Adversarial Syntax Challenger)

const assert = require('node:assert');
const {
  mockVscode,
  DiagnosticSeverity
} = require('./e2e/harness/vscodeShim');

const { SqlValidator, SqlTokenizer } = require('../dist/diagnostics/sqlValidator');

// Helper to create mock document
function createMockDocument(content) {
  const lines = content.split(/\r?\n/);
  const lineOffsets = [0];
  let cur = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    cur = content.indexOf('\n', cur) + 1;
    lineOffsets.push(cur);
  }
  return {
    uri: mockVscode.Uri.file('c:/project/test.py'),
    fileName: 'c:/project/test.py',
    languageId: 'python',
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
      for (let i = 0; i < lineOffsets.length; i++) {
        if (offset >= lineOffsets[i]) line = i;
        else break;
      }
      return new mockVscode.Position(line, offset - lineOffsets[line]);
    }
  };
}

function runValidation(sqlText) {
  const doc = createMockDocument(sqlText);
  const validator = new SqlValidator();
  const diags = validator.validateSql(
    doc,
    { text: sqlText, startOffset: 0, endOffset: sqlText.length },
    { checkSyntax: true, checkSchema: false, isCatalogConnected: false }
  );
  return {
    doc,
    diags,
    errors: diags.filter(d => d.severity === DiagnosticSeverity.Error),
    warnings: diags.filter(d => d.severity === DiagnosticSeverity.Warning)
  };
}

const results = {
  total: 0,
  passed: 0,
  failed: 0,
  findings: []
};

function test(name, fn) {
  results.total++;
  try {
    fn();
    results.passed++;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    results.failed++;
    console.error(`[FAIL] ${name}: ${err.message}`);
    results.findings.push({ name, error: err.message });
  }
}

console.log('===============================================================');
console.log('STARTING EMPIRICAL ADVERSARIAL STRESS TEST: SqlValidator');
console.log('===============================================================\n');

// ============================================================================
// 1. DEEPLY NESTED OR UNBALANCED PARENTHESES
// ============================================================================
console.log('--- CATEGORY 1: Deeply Nested & Unbalanced Parentheses ---');

test('1.1: 500 levels of balanced nested parentheses pass with 0 errors', () => {
  const depth = 500;
  const sql = `SELECT ${'('.repeat(depth)} 1 ${')'.repeat(depth)} FROM users`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got ${res.errors.length}: ${res.errors.map(e => e.message).join(', ')}`);
});

test('1.2: 500 levels of unbalanced open parentheses report 500 errors', () => {
  const depth = 500;
  const sql = `SELECT ${'('.repeat(depth)} 1 FROM users`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, depth, `Expected ${depth} errors, got ${res.errors.length}`);
  assert.match(res.errors[0].message, /unclosed parenthesis/i);
});

test('1.3: 500 levels of unmatched closing parentheses report 500 errors', () => {
  const depth = 500;
  const sql = `SELECT 1 ${')'.repeat(depth)} FROM users`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, depth, `Expected ${depth} errors, got ${res.errors.length}`);
  assert.match(res.errors[0].message, /unmatched closing parenthesis/i);
});

test('1.4: Alternating unbalanced parentheses ( ( ) ) ) ( ( )', () => {
  const sql = `SELECT ( ( 1 ) ) ) ( ( 2 ) FROM users`;
  const res = runValidation(sql);
  // ( ( 1 ) ) -> balanced
  // ) -> extra closing
  // ( ( 2 ) -> 1 unclosed opening
  const unclosed = res.errors.filter(e => /unclosed parenthesis/i.test(e.message));
  const unmatched = res.errors.filter(e => /unmatched closing/i.test(e.message));
  assert.strictEqual(unmatched.length, 1, `Expected 1 unmatched closing, got ${unmatched.length}`);
  assert.strictEqual(unclosed.length, 1, `Expected 1 unclosed opening, got ${unclosed.length}`);
});

test('1.5: Parentheses inside single-line comments are ignored', () => {
  const sql = `SELECT id -- (unclosed in comment\n FROM users WHERE (id = 1) -- ) unmatched in comment`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Parentheses in comments must not trigger errors`);
});

test('1.6: Parentheses inside block comments are ignored', () => {
  const sql = `SELECT id /* ( ( ( unclosed in block */ FROM users WHERE (id = 1) /* ) ) extra in block */`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Parentheses in block comments must not trigger errors`);
});

test('1.7: Parentheses inside string literals are ignored', () => {
  const sql = `SELECT '(' AS open_paren, ')' AS close_paren, '(((' AS many FROM users`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Parentheses in string literals must not trigger errors`);
});

test('1.8: Subquery with unclosed parenthesis in CTE reports unclosed paren', () => {
  const sql = `WITH cte AS (SELECT (a + b FROM users) SELECT * FROM cte`;
  const res = runValidation(sql);
  const unclosed = res.errors.filter(e => /unclosed parenthesis/i.test(e.message));
  assert.ok(unclosed.length >= 1, `Expected unclosed paren error inside CTE`);
});

// ============================================================================
// 2. MULTI-LINE STRINGS WITH COMMENTS
// ============================================================================
console.log('\n--- CATEGORY 2: Comments (-- and /* ... */) with Commas and Keywords ---');

test('2.1: Multi-line string with -- comment containing keywords and commas', () => {
  const sql = `SELECT
    id,
    -- FROM WHERE GROUP BY HAVING ORDER BY LIMIT ,,,
    email,
    -- another comment with ) and (
    name
  FROM users`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Comments with keywords must not trigger false errors: ${res.errors.map(e => e.message).join(', ')}`);
});

test('2.2: Multi-line string with /* ... */ comment containing boundary keywords and commas', () => {
  const sql = `SELECT
    id,
    /*
      FROM dummy_table
      WHERE a = 1,
      GROUP BY x,
      HAVING count(*) > 0
    */
    email
  FROM users`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Block comments with keywords must not trigger false errors: ${res.errors.map(e => e.message).join(', ')}`);
});

test('2.3: Comment placed directly between keyword and clause expressions', () => {
  const sql = `SELECT /* col list */ id, email FROM /* table */ users WHERE /* cond */ id = 1`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Inline block comments between keywords must not trigger false errors`);
});

test('2.4: Real trailing comma before FROM even if comment intervenes', () => {
  const sql = `SELECT id, email,
    -- some comment
    /* another comment */
  FROM users`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `Expected trailing comma before FROM error`);
  assert.match(res.errors[0].message, /trailing comma before 'FROM'/i);
});

test('2.5: Nested block comments /* /* */ */ in DuckDB SQL', () => {
  const sql = `SELECT /* outer /* inner */ still comment */ id FROM users`;
  const res = runValidation(sql);
  // DuckDB supports nested block comments. If tokenizer stops at first */,
  // it will treat "still comment */" as code and report errors!
  assert.strictEqual(res.errors.length, 0, `Nested block comments should not cause false syntax errors, got: ${res.errors.map(e => e.message).join(', ')}`);
});

test('2.6: Unclosed block comment /* ... at EOF', () => {
  const sql = `SELECT * FROM users /* unclosed comment at end`;
  const res = runValidation(sql);
  // An unclosed block comment in DuckDB is invalid SQL!
  // Probe whether SqlValidator detects unclosed block comments.
  assert.ok(res.errors.length >= 1, `Unclosed block comment should be detected as syntax error`);
});

// ============================================================================
// 3. UNCLOSED QUOTES IN TRICKY POSITIONS
// ============================================================================
console.log('\n--- CATEGORY 3: Unclosed Quotes in Tricky Positions ---');

test('3.1: Unclosed single quote at EOF', () => {
  const sql = `SELECT * FROM users WHERE name = 'alice`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `Expected unclosed quote error`);
  assert.match(res.errors[0].message, /unclosed string literal/i);
});

test('3.2: Unclosed double quote identifier at EOF', () => {
  const sql = `SELECT * FROM users WHERE "col = 1`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `Expected unclosed quoted identifier error`);
  assert.match(res.errors[0].message, /unclosed quoted identifier.*"/i);
});

test('3.3: Unclosed backtick identifier at EOF', () => {
  const sql = `SELECT * FROM users WHERE \`col = 1`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `Expected unclosed quoted identifier error`);
  assert.match(res.errors[0].message, /unclosed quoted identifier.*`/i);
});

test('3.4: Escaped quote with SQL doubled quotes (\'\') followed by real unclosed quote', () => {
  const sql = `SELECT 'O''Reilly' AS author, 'unclosed string`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 1, `Expected exactly 1 error for unclosed string`);
  assert.match(res.errors[0].message, /unclosed string literal/i);
});

test('3.5: Doubled double-quote inside identifier ("" in ANSI SQL)', () => {
  const sql = `SELECT "column""name" FROM users`;
  const res = runValidation(sql);
  // In SQL, "column""name" is an identifier with an escaped double quote.
  assert.strictEqual(res.errors.length, 0, `Doubled double-quotes in identifier must be valid, got: ${res.errors.map(e => e.message).join(', ')}`);
});

test('3.6: Unclosed quote inside parentheses does not crash or corrupt paren stack beyond bounds', () => {
  const sql = `SELECT ('unclosed) FROM users`;
  const res = runValidation(sql);
  // 'unclosed) consumes 'unclosed) as unclosed string
  assert.ok(res.errors.length >= 1, `Expected at least unclosed quote error`);
});

test('3.7: Empty string literals and empty quoted identifiers', () => {
  const sql = `SELECT '' AS empty_str, "" AS empty_id FROM users`;
  const res = runValidation(sql);
  // Note: "" in DuckDB is empty identifier. Should not cause unclosed quote error.
  const quoteErrors = res.errors.filter(e => /unclosed/i.test(e.message));
  assert.strictEqual(quoteErrors.length, 0, `Empty quotes must not be flagged as unclosed`);
});

// ============================================================================
// 4. INCOMPLETE CLAUSES
// ============================================================================
console.log('\n--- CATEGORY 4: Incomplete Clauses ---');

test('4.1: Incomplete SELECT clause: SELECT * FROM WHERE', () => {
  const sql = `SELECT * FROM WHERE id = 1`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'FROM' missing table reference/i);
});

test('4.2: Incomplete SELECT clause: SELECT FROM users', () => {
  const sql = `SELECT FROM users`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'SELECT' missing expressions/i);
});

test('4.3: Incomplete SELECT clause with DISTINCT: SELECT DISTINCT FROM users', () => {
  const sql = `SELECT DISTINCT FROM users`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'SELECT' missing expressions/i);
});

test('4.4: Incomplete SELECT clause with ALL: SELECT ALL FROM users', () => {
  const sql = `SELECT ALL FROM users`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'SELECT' missing expressions/i);
});

test('4.5: Incomplete WHERE clause: SELECT * FROM users WHERE', () => {
  const sql = `SELECT * FROM users WHERE`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'WHERE' missing condition/i);
});

test('4.6: Incomplete WHERE clause before ORDER BY: SELECT * FROM users WHERE ORDER BY id', () => {
  const sql = `SELECT * FROM users WHERE ORDER BY id`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'WHERE' missing condition/i);
});

test('4.7: Incomplete GROUP BY clause: SELECT id FROM users GROUP BY HAVING count(*) > 1', () => {
  const sql = `SELECT id FROM users GROUP BY HAVING count(*) > 1`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'GROUP BY' missing expressions/i);
});

test('4.8: Incomplete GROUP BY clause before ORDER BY: SELECT id FROM users GROUP BY ORDER BY id', () => {
  const sql = `SELECT id FROM users GROUP BY ORDER BY id`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'GROUP BY' missing expressions/i);
});

test('4.9: Incomplete GROUP keyword without BY: SELECT count(*) FROM users GROUP', () => {
  const sql = `SELECT count(*) FROM users GROUP`;
  const res = runValidation(sql);
  // Is "GROUP" without "BY" detected as incomplete clause?
  assert.ok(res.errors.length >= 1, `GROUP without BY must be flagged as incomplete clause, got 0 errors`);
});

test('4.10: Incomplete ORDER keyword without BY: SELECT * FROM users ORDER', () => {
  const sql = `SELECT * FROM users ORDER`;
  const res = runValidation(sql);
  // Is "ORDER" without "BY" detected as incomplete clause?
  assert.ok(res.errors.length >= 1, `ORDER without BY must be flagged as incomplete clause, got 0 errors`);
});

test('4.11: Incomplete GROUP keyword without BY before WHERE: SELECT * FROM users GROUP WHERE id = 1', () => {
  const sql = `SELECT * FROM users GROUP WHERE id = 1`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `GROUP without BY before WHERE must be flagged as incomplete clause, got 0 errors`);
});

test('4.12: Incomplete JOIN clause: SELECT * FROM a JOIN ON a.id = 1', () => {
  const sql = `SELECT * FROM a JOIN ON a.id = 1`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'JOIN' missing table reference/i);
});

test('4.13: Incomplete JOIN clause: SELECT * FROM a LEFT JOIN WHERE a.id = 1', () => {
  const sql = `SELECT * FROM a LEFT JOIN WHERE a.id = 1`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'JOIN' missing table reference/i);
});

test('4.14: Incomplete LEFT keyword without JOIN: SELECT * FROM a LEFT WHERE a.id = 1', () => {
  const sql = `SELECT * FROM a LEFT WHERE a.id = 1`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `LEFT without JOIN must be flagged as incomplete clause, got 0 errors`);
});

test('4.15: Incomplete LIMIT clause: SELECT * FROM users LIMIT', () => {
  const sql = `SELECT * FROM users LIMIT`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'LIMIT' missing count/i);
});

test('4.16: Incomplete SET clause: UPDATE users SET WHERE id = 1', () => {
  const sql = `UPDATE users SET WHERE id = 1`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /incomplete clause: 'SET' missing assignments/i);
});

// ============================================================================
// 5. DANGLING OPERATORS
// ============================================================================
console.log('\n--- CATEGORY 5: Dangling Binary & Comparison Operators ---');

const opsToTest = ['=', '!=', '<>', '<', '>', '<=', '>=', '==', '+', '-', '/', '%'];
for (const op of opsToTest) {
  test(`5.1: Dangling binary operator '${op}' at EOF`, () => {
    const sql = `SELECT * FROM users WHERE id ${op}`;
    const res = runValidation(sql);
    assert.ok(res.errors.length >= 1, `Expected dangling operator error for '${op}'`);
    assert.match(res.errors[0].message, new RegExp(`dangling operator '${op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i'));
  });

  test(`5.2: Dangling binary operator '${op}' before AND`, () => {
    const sql = `SELECT * FROM users WHERE id ${op} AND email = 'test'`;
    const res = runValidation(sql);
    assert.ok(res.errors.length >= 1, `Expected dangling operator error for '${op}' before AND`);
    assert.match(res.errors[0].message, new RegExp(`dangling operator '${op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i'));
  });
}

test('5.3: CRITICAL PROBE - Dangling multiplication operator * at EOF', () => {
  const sql = `SELECT 1 + 2 *`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `Expected dangling operator error for '*' at EOF, got 0 errors`);
  assert.match(res.errors[0].message, /dangling operator '\*'/i);
});

test('5.4: CRITICAL PROBE - Dangling multiplication operator * before FROM', () => {
  const sql = `SELECT id * FROM users`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `Expected dangling operator error for 'id * FROM users', got 0 errors`);
  assert.match(res.errors[0].message, /dangling operator '\*'/i);
});

test('5.5: Dangling logical AND at EOF', () => {
  const sql = `SELECT * FROM users WHERE id = 1 AND`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /dangling operator 'AND'/i);
});

test('5.6: Dangling logical OR at EOF', () => {
  const sql = `SELECT * FROM users WHERE id = 1 OR`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /dangling operator 'OR'/i);
});

test('5.7: Dangling LIKE operator at EOF', () => {
  const sql = `SELECT * FROM users WHERE name LIKE`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /dangling operator 'LIKE'/i);
});

test('5.8: Dangling IS operator at EOF', () => {
  const sql = `SELECT * FROM users WHERE id IS`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /dangling operator 'IS'/i);
});

test('5.9: Dangling IN operator at EOF', () => {
  const sql = `SELECT * FROM users WHERE id IN`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /dangling operator 'IN'/i);
});

test('5.10: Dangling NOT operator at EOF', () => {
  const sql = `SELECT * FROM users WHERE NOT`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1);
  assert.match(res.errors[0].message, /dangling operator 'NOT'/i);
});

test('5.11: Valid unary minus and plus with numbers and expressions', () => {
  const sql = `SELECT -5, +10, -total_amount FROM orders WHERE score > -10`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Valid unary signs must not be flagged as dangling operators: ${res.errors.map(e => e.message).join(', ')}`);
});

test('5.12: Valid wildcard * in SELECT, COUNT(*), table.*', () => {
  const sql = `SELECT *, COUNT(*), u.* FROM users u`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Valid wildcard * must not be flagged as dangling operators: ${res.errors.map(e => e.message).join(', ')}`);
});

// ============================================================================
// 6. FALSE POSITIVES & DUCKDB / PYTHON SPECIFIC SYNTAX
// ============================================================================
console.log('\n--- CATEGORY 6: False Positives & DuckDB / Python Specific Syntax ---');

test('6.1: Prepared statement parameter ? in WHERE id = ?', () => {
  const sql = `SELECT * FROM users WHERE id = ?`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `WHERE id = ? must NOT be flagged as dangling operator! Got: ${res.errors.map(e => e.message).join(', ')}`);
});

test('6.2: Prepared statement parameter ? with multiple parameters: WHERE id = ? AND email = ?', () => {
  const sql = `SELECT * FROM users WHERE id = ? AND email = ?`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `WHERE id = ? AND email = ? must NOT be flagged! Got: ${res.errors.map(e => e.message).join(', ')}`);
});

test('6.3: Prepared statement parameter ? inside IN (?, ?, ?)', () => {
  const sql = `SELECT * FROM users WHERE id IN (?, ?, ?)`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `WHERE id IN (?, ?, ?) must NOT be flagged with trailing comma or syntax errors! Got: ${res.errors.map(e => e.message).join(', ')}`);
});

test('6.4: Named parameters :param or $param', () => {
  const sql = `SELECT * FROM users WHERE id = :user_id AND email = $user_email`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Named parameters :id or $id must not trigger dangling operator: ${res.errors.map(e => e.message).join(', ')}`);
});

test('6.5: String concatenation operator ||', () => {
  const sql = `SELECT first_name || ' ' || last_name AS full_name FROM users`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `String concatenation || must be valid: ${res.errors.map(e => e.message).join(', ')}`);
});

test('6.6: Dangling string concatenation operator ||', () => {
  const sql = `SELECT first_name || FROM users`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `Dangling || should be flagged as dangling operator, got 0 errors`);
});

test('6.7: DuckDB specific SELECT * EXCLUDE (col1, col2) FROM users', () => {
  const sql = `SELECT * EXCLUDE (password, secret) FROM users`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `DuckDB EXCLUDE syntax must not be flagged: ${res.errors.map(e => e.message).join(', ')}`);
});

test('6.8: DuckDB specific SELECT * REPLACE (salary * 1.1 AS salary) FROM users', () => {
  const sql = `SELECT * REPLACE (salary * 1.1 AS salary) FROM users`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `DuckDB REPLACE syntax must not be flagged: ${res.errors.map(e => e.message).join(', ')}`);
});

test('6.9: DuckDB specific COLUMNS(\'pattern\')', () => {
  const sql = `SELECT COLUMNS('cost.*') FROM expenses`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `COLUMNS() syntax must not be flagged: ${res.errors.map(e => e.message).join(', ')}`);
});

test('6.10: Trailing comma in CTE list before main SELECT: WITH c AS (SELECT 1), SELECT * FROM c', () => {
  const sql = `WITH c AS (SELECT 1), SELECT * FROM c`;
  const res = runValidation(sql);
  assert.ok(res.errors.length >= 1, `Trailing comma before SELECT in CTE must be flagged as error, got 0 errors`);
});

// ============================================================================
// 7. PERFORMANCE AND ROBUSTNESS STRESS TEST
// ============================================================================
console.log('\n--- CATEGORY 7: Performance & Robustness Stress Harness ---');

test('7.1: Large Python script with 100 queries validated under 100ms', () => {
  const queries = [];
  for (let i = 0; i < 100; i++) {
    queries.push(`con.sql("""
      WITH query_${i} AS (
        SELECT id, name, created_at
        FROM table_${i}
        WHERE id > ${i} AND score <= ${i * 1.5}
      )
      SELECT *
      FROM query_${i}
      ORDER BY id
      LIMIT 10
    """)`);
  }
  const bigScript = queries.join('\n\n');
  const t0 = performance.now();
  
  // We validate each block (simulating SqlDiagnosticsManager batch validation)
  const validator = new SqlValidator();
  const doc = createMockDocument(bigScript);
  
  // Extract blocks or validate all
  let totalErrors = 0;
  for (let i = 0; i < 100; i++) {
    const q = `WITH query_${i} AS (SELECT id, name FROM table_${i} WHERE id > ${i}) SELECT * FROM query_${i} LIMIT 10`;
    const res = validator.validateSql(
      doc,
      { text: q, startOffset: 0, endOffset: q.length },
      { checkSyntax: true, checkSchema: false, isCatalogConnected: false }
    );
    totalErrors += res.length;
  }
  const elapsed = performance.now() - t0;
  console.log(`    Validated 100 queries in ${elapsed.toFixed(2)}ms (${(elapsed / 100).toFixed(3)}ms/query)`);
  assert.strictEqual(totalErrors, 0, `Expected 0 errors across 100 valid queries`);
  assert.ok(elapsed < 100, `Expected 100 queries under 100ms, took ${elapsed.toFixed(2)}ms`);
});

test('7.2: Giant single SQL query (1,000 columns, 50 JOINs, 50,000 chars) validates under 50ms', () => {
  const cols = Array.from({ length: 1000 }, (_, i) => `col_${i}`).join(', ');
  const joins = Array.from({ length: 50 }, (_, i) => `LEFT JOIN table_${i} t${i} ON t.id = t${i}.t_id`).join('\n');
  const giantSql = `SELECT ${cols} FROM main_table t\n${joins}\nWHERE t.status = 'active'\nORDER BY t.id LIMIT 100`;

  const t0 = performance.now();
  const res = runValidation(giantSql);
  const elapsed = performance.now() - t0;
  console.log(`    Validated 50KB giant query in ${elapsed.toFixed(2)}ms`);
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors on giant query: ${res.errors.map(e => e.message).join(', ')}`);
  assert.ok(elapsed < 50, `Giant query took ${elapsed.toFixed(2)}ms, expected < 50ms`);
});

test('7.3: Deeply nested subqueries (50 levels)', () => {
  let nested = 'SELECT 1';
  for (let i = 0; i < 50; i++) {
    nested = `SELECT * FROM (${nested}) AS sub_${i}`;
  }
  const res = runValidation(nested);
  assert.strictEqual(res.errors.length, 0, `50 levels of nested subqueries must validate cleanly`);
});

// ============================================================================
// 8. RANGE & POSITION COORDINATE PRECISION IN PYTHON SCRIPTS
// ============================================================================
console.log('\n--- CATEGORY 8: Range & Position Precision in Python Scripts ---');

test('8.1: Exact range of trailing comma in multiline Python script', () => {
  const pythonScript = `import duckdb\n\ncon = duckdb.connect()\ncon.sql("""\nSELECT\n    id,\n    email,\nFROM users\n""")`;
  // Let's find the start offset of the SQL block:
  const blockStart = pythonScript.indexOf('SELECT\n');
  const blockEnd = pythonScript.lastIndexOf('"""');
  const sqlText = pythonScript.slice(blockStart, blockEnd);
  const doc = createMockDocument(pythonScript);
  const validator = new SqlValidator();
  const diags = validator.validateSql(
    doc,
    { text: sqlText, startOffset: blockStart, endOffset: blockEnd },
    { checkSyntax: true, checkSchema: false, isCatalogConnected: false }
  );
  assert.strictEqual(diags.length, 1, `Expected 1 error for trailing comma, got: ${diags.map(d => d.message).join(', ')}`);
  const d = diags[0];
  // 'email,' is on line 6: "    email," -> comma is at index 9 (4 spaces + 5 chars 'email' = index 9)
  assert.strictEqual(d.range.start.line, 6, `Expected error on line 6, got line ${d.range.start.line}`);
  assert.strictEqual(d.range.start.character, 9, `Expected error at col 9, got col ${d.range.start.character}`);
  assert.strictEqual(d.range.end.character, 10, `Expected error to span 1 char (col 10), got col ${d.range.end.character}`);
});

test('8.2: Exact range of unclosed parenthesis in Python script', () => {
  const pythonScript = `con.sql("""SELECT (a + b FROM users""")`;
  const blockStart = pythonScript.indexOf('SELECT');
  const sqlText = `SELECT (a + b FROM users`;
  const doc = createMockDocument(pythonScript);
  const validator = new SqlValidator();
  const diags = validator.validateSql(
    doc,
    { text: sqlText, startOffset: blockStart, endOffset: blockStart + sqlText.length },
    { checkSyntax: true, checkSchema: false, isCatalogConnected: false }
  );
  assert.strictEqual(diags.length, 1);
  const d = diags[0];
  assert.strictEqual(d.range.start.line, 0);
  assert.strictEqual(d.range.start.character, 18); // 'con.sql("""SELECT (' -> 11 + 7 = 18
  assert.strictEqual(d.range.end.character, 19);
});

console.log('\n===============================================================');
console.log(`STRESS TEST SUMMARY: Total: ${results.total} | Passed: ${results.passed} | Failed: ${results.failed}`);
console.log('===============================================================');
if (results.findings.length > 0) {
  console.log('\nFAILED TEST CASES (BUGS & VULNERABILITIES IDENTIFIED):');
  results.findings.forEach((f, idx) => {
    console.log(`  ${idx + 1}. ${f.name}`);
    console.log(`     Reason: ${f.error}`);
  });
}

