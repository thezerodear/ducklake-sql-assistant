// test/adversarial_probe_r2.js
// Deep Adversarial Probe & Verification Suite R2 for SqlValidator
// Author: Adversarial Syntax Re-Verification Challenger R2

const assert = require('node:assert');
const {
  mockVscode,
  DiagnosticSeverity
} = require('./e2e/harness/vscodeShim');

const { SqlValidator } = require('../dist/diagnostics/sqlValidator');

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

const stats = {
  total: 0,
  passed: 0,
  failed: 0,
  failures: []
};

function test(name, fn) {
  stats.total++;
  try {
    fn();
    stats.passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    stats.failed++;
    console.error(`  [FAIL] ${name}: ${err.message}`);
    stats.failures.push({ name, error: err.message });
  }
}

console.log('======================================================================');
console.log('ADVERSARIAL RE-VERIFICATION PROBE R2: TARGETED DIMENSION STRESS TESTS');
console.log('======================================================================\n');

// ----------------------------------------------------------------------------
// DIMENSION 1: Parameterized queries with '?' markers
// ----------------------------------------------------------------------------
console.log('>>> DIMENSION 1: Parameterized Queries (?)');

test('D1.1: WHERE col = ? produces 0 errors', () => {
  const res = runValidation('SELECT * FROM users WHERE id = ?');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.2: WHERE col1 = ? AND col2 = ? produces 0 errors', () => {
  const res = runValidation('SELECT * FROM users WHERE col1 = ? AND col2 = ?');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.3: WHERE col IN (?, ?, ?) produces 0 errors', () => {
  const res = runValidation('SELECT * FROM users WHERE status IN (?, ?, ?)');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.4: WHERE col IN (?) single parameter produces 0 errors', () => {
  const res = runValidation('SELECT * FROM users WHERE status IN (?)');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.5: INSERT INTO t (a, b) VALUES (?, ?) produces 0 errors', () => {
  const res = runValidation('INSERT INTO users (id, name) VALUES (?, ?)');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.6: INSERT INTO t VALUES (?, ?, ?) produces 0 errors', () => {
  const res = runValidation('INSERT INTO users VALUES (?, ?, ?)');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.7: SELECT ? AS param produces 0 errors', () => {
  const res = runValidation('SELECT ? AS param');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.8: Arithmetic with parameter: SELECT ? + 10, ? * 2 FROM t produces 0 errors', () => {
  const res = runValidation('SELECT ? + 10, ? * 2 FROM t');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.9: DuckDB positional parameter markers ?1, ?2 produce 0 errors', () => {
  const res = runValidation('SELECT * FROM users WHERE id = ?1 AND role = ?2');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.10: Parameterized LIMIT and OFFSET: SELECT * FROM t LIMIT ? OFFSET ? produces 0 errors', () => {
  const res = runValidation('SELECT * FROM t LIMIT ? OFFSET ?');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.11: UPDATE with parameters: UPDATE users SET name = ?, email = ? WHERE id = ? produces 0 errors', () => {
  const res = runValidation('UPDATE users SET name = ?, email = ? WHERE id = ?');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D1.12: Trailing comma in parameter list: IN (?, ?, ,) flags trailing comma', () => {
  const res = runValidation('SELECT * FROM users WHERE id IN (?, ?, ,)');
  assert.ok(res.errors.length >= 1, 'Expected trailing comma error');
  assert.match(res.errors[0].message, /trailing comma before '\)'/i);
});

test('D1.13: Trailing comma in VALUES parameter list: VALUES (?, ?,) flags trailing comma', () => {
  const res = runValidation('INSERT INTO users VALUES (?, ?,)');
  assert.ok(res.errors.length >= 1, 'Expected trailing comma error');
  assert.match(res.errors[0].message, /trailing comma before '\)'/i);
});

test('D1.14: Dangling operator after parameter: WHERE id = ? AND flags dangling operator', () => {
  const res = runValidation('SELECT * FROM users WHERE id = ? AND');
  assert.ok(res.errors.length >= 1, 'Expected dangling operator error');
  assert.match(res.errors[0].message, /dangling operator 'AND'/i);
});


// ----------------------------------------------------------------------------
// DIMENSION 2: Multiplication '*' vs Wildcard '*'
// ----------------------------------------------------------------------------
console.log('\n>>> DIMENSION 2: Multiplication (*) vs Wildcard (*)');

test('D2.1: Simple multiplication: SELECT 1 * 2 produces 0 errors', () => {
  const res = runValidation('SELECT 1 * 2');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D2.2: Standard wildcard: SELECT * FROM t produces 0 errors', () => {
  const res = runValidation('SELECT * FROM t');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D2.3: Dangling multiplication before FROM: SELECT id * FROM t flags dangling operator', () => {
  const res = runValidation('SELECT id * FROM t');
  assert.ok(res.errors.length >= 1, 'Expected dangling operator error for id * FROM');
  assert.match(res.errors[0].message, /dangling operator '\*'/i);
});

test('D2.4: Qualified wildcard: SELECT t.* FROM t produces 0 errors', () => {
  const res = runValidation('SELECT t.* FROM t');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D2.5: SELECT DISTINCT * FROM t produces 0 errors', () => {
  const res = runValidation('SELECT DISTINCT * FROM t');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D2.6: SELECT ALL * FROM t produces 0 errors', () => {
  const res = runValidation('SELECT ALL * FROM t');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D2.7: COUNT(*) and COUNT(DISTINCT *) produce 0 errors', () => {
  const res = runValidation('SELECT COUNT(*), COUNT(DISTINCT *) FROM t');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D2.8: SELECT a, * FROM t and SELECT *, b FROM t produce 0 errors', () => {
  const res1 = runValidation('SELECT a, * FROM t');
  const res2 = runValidation('SELECT *, b FROM t');
  assert.strictEqual(res1.errors.length, 0, `SELECT a, * failed: ${res1.errors.map(e => e.message).join('; ')}`);
  assert.strictEqual(res2.errors.length, 0, `SELECT *, b failed: ${res2.errors.map(e => e.message).join('; ')}`);
});

test('D2.9: Chained multiplication: SELECT a * b * c * d FROM t produces 0 errors', () => {
  const res = runValidation('SELECT a * b * c * d FROM t');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D2.10: Multiplication with parentheses: SELECT (a + b) * (c - d) FROM t produces 0 errors', () => {
  const res = runValidation('SELECT (a + b) * (c - d) FROM t');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D2.11: Dangling * inside parentheses: SELECT (a *) FROM t flags dangling operator', () => {
  const res = runValidation('SELECT (a *) FROM t');
  assert.ok(res.errors.length >= 1, 'Expected dangling operator * error');
  assert.match(res.errors[0].message, /dangling operator '\*'/i);
});

test('D2.12: Dangling * before comma: SELECT a * , b FROM t flags dangling operator', () => {
  const res = runValidation('SELECT a * , b FROM t');
  assert.ok(res.errors.length >= 1, 'Expected dangling operator * error');
  assert.match(res.errors[0].message, /dangling operator '\*'/i);
});

test('D2.13: Double operator: SELECT a * / b FROM t flags dangling operator', () => {
  const res = runValidation('SELECT a * / b FROM t');
  assert.ok(res.errors.length >= 1, 'Expected dangling operator error');
  assert.match(res.errors[0].message, /dangling operator '\*'/i);
});

test('D2.14: Multiplication with negative number: SELECT a * -5.0 FROM t produces 0 errors', () => {
  const res = runValidation('SELECT a * -5.0 FROM t');
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});


// ----------------------------------------------------------------------------
// DIMENSION 3: Incomplete Clauses (GROUP/ORDER without BY, Modifiers without JOIN)
// ----------------------------------------------------------------------------
console.log('\n>>> DIMENSION 3: Incomplete Clauses');

test('D3.1: Incomplete GROUP without BY at EOF: SELECT count(*) FROM users GROUP flags missing BY', () => {
  const res = runValidation('SELECT count(*) FROM users GROUP');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'GROUP' missing 'BY'/i);
});

test('D3.2: Incomplete GROUP without BY before ORDER: SELECT id FROM users GROUP ORDER BY id flags missing BY', () => {
  const res = runValidation('SELECT id FROM users GROUP ORDER BY id');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'GROUP' missing 'BY'/i);
});

test('D3.3: Incomplete GROUP without BY before semicolon: SELECT id FROM users GROUP; flags missing BY', () => {
  const res = runValidation('SELECT id FROM users GROUP;');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'GROUP' missing 'BY'/i);
});

test('D3.4: Incomplete GROUP BY with BY but missing expressions: SELECT id FROM users GROUP BY flags missing expressions', () => {
  const res = runValidation('SELECT id FROM users GROUP BY');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'GROUP BY' missing expressions/i);
});

test('D3.5: Incomplete ORDER without BY at EOF: SELECT * FROM users ORDER flags missing BY', () => {
  const res = runValidation('SELECT * FROM users ORDER');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'ORDER' missing 'BY'/i);
});

test('D3.6: Incomplete ORDER without BY before LIMIT: SELECT * FROM users ORDER LIMIT 10 flags missing BY', () => {
  const res = runValidation('SELECT * FROM users ORDER LIMIT 10');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'ORDER' missing 'BY'/i);
});

test('D3.7: Incomplete ORDER BY with BY but missing expressions: SELECT * FROM users ORDER BY flags missing expressions', () => {
  const res = runValidation('SELECT * FROM users ORDER BY');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'ORDER BY' missing expressions/i);
});

test('D3.8: Incomplete LEFT without JOIN: SELECT * FROM a LEFT WHERE a.id = 1 flags missing JOIN', () => {
  const res = runValidation('SELECT * FROM a LEFT WHERE a.id = 1');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'LEFT' missing 'JOIN'/i);
});

test('D3.9: Incomplete RIGHT without JOIN: SELECT * FROM a RIGHT WHERE a.id = 1 flags missing JOIN', () => {
  const res = runValidation('SELECT * FROM a RIGHT WHERE a.id = 1');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'RIGHT' missing 'JOIN'/i);
});

test('D3.10: Incomplete INNER without JOIN: SELECT * FROM a INNER WHERE a.id = 1 flags missing JOIN', () => {
  const res = runValidation('SELECT * FROM a INNER WHERE a.id = 1');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'INNER' missing 'JOIN'/i);
});

test('D3.11: Incomplete FULL without JOIN: SELECT * FROM a FULL WHERE a.id = 1 flags missing JOIN', () => {
  const res = runValidation('SELECT * FROM a FULL WHERE a.id = 1');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'FULL' missing 'JOIN'/i);
});

test('D3.12: Incomplete CROSS without JOIN: SELECT * FROM a CROSS WHERE a.id = 1 flags missing JOIN', () => {
  const res = runValidation('SELECT * FROM a CROSS WHERE a.id = 1');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'CROSS' missing 'JOIN'/i);
});

test('D3.13: Incomplete LEFT OUTER without JOIN: SELECT * FROM a LEFT OUTER WHERE a.id = 1 flags missing JOIN', () => {
  const res = runValidation('SELECT * FROM a LEFT OUTER WHERE a.id = 1');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'LEFT' missing 'JOIN'/i);
});

test('D3.14: Incomplete JOIN missing table reference: SELECT * FROM a JOIN ON a.id = 1 flags missing table reference', () => {
  const res = runValidation('SELECT * FROM a JOIN ON a.id = 1');
  assert.ok(res.errors.length >= 1, 'Expected incomplete clause error');
  assert.match(res.errors[0].message, /incomplete clause: 'JOIN' missing table reference/i);
});

test('D3.15: Valid complete JOINs (LEFT JOIN, RIGHT JOIN, FULL OUTER JOIN) produce 0 errors', () => {
  const sql = `SELECT * FROM a LEFT JOIN b ON a.id = b.id RIGHT JOIN c ON b.id = c.id FULL OUTER JOIN d ON c.id = d.id`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Valid joins must produce 0 errors: ${res.errors.map(e => e.message).join('; ')}`);
});


// ----------------------------------------------------------------------------
// DIMENSION 3B: Deep Adversarial Probe of Built-in Functions LEFT(...) and RIGHT(...)
// ----------------------------------------------------------------------------
console.log('\n>>> DIMENSION 3B: Built-in String Functions LEFT() / RIGHT() vs CLAUSE_BOUNDARY_KEYWORDS');

test('D3B.1: SELECT LEFT(col, 2) FROM t must produce 0 errors', () => {
  const res = runValidation('SELECT LEFT(col, 2) FROM t');
  assert.strictEqual(res.errors.length, 0, `SELECT LEFT(col, 2) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.2: SELECT col1, LEFT(col2, 2) FROM t must produce 0 errors', () => {
  const res = runValidation('SELECT col1, LEFT(col2, 2) FROM t');
  assert.strictEqual(res.errors.length, 0, `SELECT col1, LEFT(...) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.3: SELECT RIGHT(col, 3) FROM t must produce 0 errors', () => {
  const res = runValidation('SELECT RIGHT(col, 3) FROM t');
  assert.strictEqual(res.errors.length, 0, `SELECT RIGHT(col, 3) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.4: SELECT col1, RIGHT(col2, 3) FROM t must produce 0 errors', () => {
  const res = runValidation('SELECT col1, RIGHT(col2, 3) FROM t');
  assert.strictEqual(res.errors.length, 0, `SELECT col1, RIGHT(...) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.5: WHERE LEFT(col, 1) = \'A\' must produce 0 errors', () => {
  const res = runValidation("SELECT * FROM users WHERE LEFT(name, 1) = 'A'");
  assert.strictEqual(res.errors.length, 0, `WHERE LEFT(...) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.6: WHERE RIGHT(col, 2) = \'99\' must produce 0 errors', () => {
  const res = runValidation("SELECT * FROM users WHERE RIGHT(code, 2) = '99'");
  assert.strictEqual(res.errors.length, 0, `WHERE RIGHT(...) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.7: WHERE code = LEFT(name, 5) must produce 0 errors', () => {
  const res = runValidation('SELECT * FROM users WHERE code = LEFT(name, 5)');
  assert.strictEqual(res.errors.length, 0, `WHERE code = LEFT(...) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.8: WHERE code LIKE RIGHT(name, 3) must produce 0 errors', () => {
  const res = runValidation('SELECT * FROM users WHERE code LIKE RIGHT(name, 3)');
  assert.strictEqual(res.errors.length, 0, `WHERE code LIKE RIGHT(...) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.9: SELECT \'prefix_\' || LEFT(name, 3) FROM users must produce 0 errors', () => {
  const res = runValidation("SELECT 'prefix_' || LEFT(name, 3) FROM users");
  assert.strictEqual(res.errors.length, 0, `|| LEFT(...) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.10: HAVING LEFT(dept, 1) = \'A\' must produce 0 errors', () => {
  const res = runValidation("SELECT dept, count(*) FROM users GROUP BY dept HAVING LEFT(dept, 1) = 'A'");
  assert.strictEqual(res.errors.length, 0, `HAVING LEFT(...) failed: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D3B.11: ON LEFT(a.id, 2) = b.id must produce 0 errors', () => {
  const res = runValidation('SELECT * FROM a JOIN b ON LEFT(a.id, 2) = b.id');
  assert.strictEqual(res.errors.length, 0, `ON LEFT(...) failed: ${res.errors.map(e => e.message).join('; ')}`);
});


// ----------------------------------------------------------------------------
// DIMENSION 4: Unclosed Block Comments /* ... at EOF
// ----------------------------------------------------------------------------
console.log('\n>>> DIMENSION 4: Unclosed Block Comments (/* ... at EOF)');

test('D4.1: Unclosed block comment at EOF flags error', () => {
  const res = runValidation('SELECT * FROM users /* unclosed comment at EOF');
  assert.ok(res.errors.length >= 1, 'Expected unclosed block comment error');
  assert.match(res.errors[0].message, /unclosed block comment starting with \/\*/i);
});

test('D4.2: Unclosed block comment at beginning of query flags error', () => {
  const res = runValidation('/* unclosed comment only');
  assert.ok(res.errors.length >= 1, 'Expected unclosed block comment error');
  assert.match(res.errors[0].message, /unclosed block comment starting with \/\*/i);
});

test('D4.3: Unclosed nested block comment /* outer /* inner */ still unclosed flags error', () => {
  const res = runValidation('SELECT 1 /* outer /* inner */ still unclosed at EOF');
  assert.ok(res.errors.length >= 1, 'Expected unclosed block comment error');
  assert.match(res.errors[0].message, /unclosed block comment starting with \/\*/i);
});

test('D4.4: Balanced nested block comment /* outer /* inner */ outer */ produces 0 errors', () => {
  const res = runValidation('SELECT 1 /* outer /* inner */ outer */ FROM users');
  assert.strictEqual(res.errors.length, 0, `Balanced nested comments must produce 0 errors: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D4.5: Multiple balanced block comments produce 0 errors', () => {
  const res = runValidation('SELECT /* c1 */ id /* c2 */, email /* c3 */ FROM /* c4 */ users /* c5 */');
  assert.strictEqual(res.errors.length, 0, `Multiple block comments must produce 0 errors: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D4.6: Unclosed block comment inside CTE flags error', () => {
  const res = runValidation('WITH cte AS (SELECT 1 /* unclosed in CTE) SELECT * FROM cte');
  assert.ok(res.errors.length >= 1, 'Expected unclosed block comment error');
  assert.match(res.errors[0].message, /unclosed block comment/i);
});


// ----------------------------------------------------------------------------
// DIMENSION 5: String Concatenation ||
// ----------------------------------------------------------------------------
console.log('\n>>> DIMENSION 5: String Concatenation (||)');

test('D5.1: Valid string concatenation: SELECT first_name || \' \' || last_name produces 0 errors', () => {
  const res = runValidation("SELECT first_name || ' ' || last_name AS full_name FROM users");
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D5.2: Multiple chained concatenation produces 0 errors', () => {
  const res = runValidation("SELECT 'a' || 'b' || 'c' || 'd' AS chained");
  assert.strictEqual(res.errors.length, 0, `Expected 0 errors, got: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D5.3: Dangling concatenation || at EOF flags error', () => {
  const res = runValidation("SELECT first_name ||");
  assert.ok(res.errors.length >= 1, 'Expected dangling operator error for ||');
  assert.match(res.errors[0].message, /dangling operator '\|\|'/i);
});

test('D5.4: Dangling concatenation || before FROM flags error', () => {
  const res = runValidation("SELECT first_name || FROM users");
  assert.ok(res.errors.length >= 1, 'Expected dangling operator error for || before FROM');
  assert.match(res.errors[0].message, /dangling operator '\|\|'/i);
});

test('D5.5: Dangling concatenation || before comma flags error', () => {
  const res = runValidation("SELECT first_name || , last_name FROM users");
  assert.ok(res.errors.length >= 1, 'Expected dangling operator error for || before comma');
  assert.match(res.errors[0].message, /dangling operator '\|\|'/i);
});

test('D5.6: Dangling concatenation || before semicolon flags error', () => {
  const res = runValidation("SELECT first_name || ;");
  assert.ok(res.errors.length >= 1, 'Expected dangling operator error for || before semicolon');
  assert.match(res.errors[0].message, /dangling operator '\|\|'/i);
});

test('D5.7: Dangling concatenation || inside parenthesis flags error', () => {
  const res = runValidation("SELECT (first_name ||) FROM users");
  assert.ok(res.errors.length >= 1, 'Expected dangling operator error for || inside paren');
  assert.match(res.errors[0].message, /dangling operator '\|\|'/i);
});

test('D5.8: Dangling concatenation || before WHERE condition flags error', () => {
  const res = runValidation("SELECT * FROM users WHERE first_name || AND status = 1");
  assert.ok(res.errors.length >= 1, 'Expected dangling operator error for || before AND');
  assert.match(res.errors[0].message, /dangling operator '\|\|'/i);
});


// ----------------------------------------------------------------------------
// DIMENSION 6: Complex Cross-Cutting Stress Scenarios
// ----------------------------------------------------------------------------
console.log('\n>>> DIMENSION 6: Complex Cross-Cutting Stress Scenarios');

test('D6.1: Lowercase keywords with parameters, joins, and window functions produce 0 errors', () => {
  const sql = `select id, sum(amount) over (partition by user_id order by id) from users left join orders on users.id = orders.user_id where status = ? group by id order by id limit ?`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Lowercase query must validate cleanly: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D6.2: Thai unicode column in multiplication and parameters: SELECT เงินเดือน * ? FROM พนักงาน produces 0 errors', () => {
  const res = runValidation('SELECT เงินเดือน * ? FROM พนักงาน WHERE แผนก = ?');
  assert.strictEqual(res.errors.length, 0, `Thai unicode query must validate cleanly: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D6.3: Multi-statement queries separated by semicolon produce 0 errors', () => {
  const sql = `SELECT 1; SELECT 2; SELECT * FROM users WHERE id = ?;`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Multi-statement query must validate cleanly: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D6.4: Trailing semicolon with trailing whitespace produces 0 errors', () => {
  const sql = `SELECT 1 FROM users ;   \n  `;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `Trailing semicolon with whitespace must produce 0 errors: ${res.errors.map(e => e.message).join('; ')}`);
});

test('D6.5: CTE with multiplication, joins, and parameters produces 0 errors', () => {
  const sql = `WITH filtered AS (
    SELECT id, price * quantity AS total
    FROM sales
    WHERE region = ?
  )
  SELECT total || ' USD' AS display
  FROM filtered
  ORDER BY total DESC
  LIMIT ?`;
  const res = runValidation(sql);
  assert.strictEqual(res.errors.length, 0, `CTE with mixed features must produce 0 errors: ${res.errors.map(e => e.message).join('; ')}`);
});

console.log('\n======================================================================');
console.log(`ADVERSARIAL PROBE R2 SUMMARY: Total: ${stats.total} | Passed: ${stats.passed} | Failed: ${stats.failed}`);
console.log('======================================================================');
if (stats.failures.length > 0) {
  console.log('\nFAILURES DETECTED:');
  stats.failures.forEach((f, i) => {
    console.log(`  ${i + 1}. ${f.name}`);
    console.log(`     Error: ${f.error}`);
  });
}

process.exit(stats.failed > 0 ? 1 : 0);
