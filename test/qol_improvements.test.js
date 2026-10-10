// test/qol_improvements.test.js
// Verification suite for Autocomplete & Editing Quality-of-Life (QoL) improvements

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Install headless VS Code shim
const { mockVscode } = require('./e2e/harness/vscodeShim');

const { TRIGGER_CHARACTERS } = require('../dist/extension');
const { DuckLakeCompletionProvider } = require('../dist/providers/completionProvider');
const {
  toggleCommentCommand,
  toggleSqlLineComment,
  isSqlCommented,
  isPositionInsideSql,
  isLineInsideSqlRange
} = require('../dist/commands/commentCommand');
const { SqlDetector } = require('../dist/parser/sqlDetector');

function createMockSchemaManager() {
  return {
    readConfig: () => ({
      enableSmartHeuristic: true,
      suggestDuckDBFunctions: true
    }),
    getColumnsForTable: () => [],
    getTables: () => [],
    getDatabases: () => [],
    getAllColumns: () => []
  };
}

// Mock TextDocument helper
function createMockDocument(content, uriPath = 'c:/project/test.py') {
  const lines = content.split(/\r?\n/);
  const lineOffsets = [0];
  let cur = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    cur = content.indexOf('\n', cur) + 1;
    lineOffsets.push(cur);
  }

  return {
    uri: mockVscode.Uri.file(uriPath),
    getText: (range) => {
      if (!range) return content;
      const start = lineOffsets[range.start.line] + range.start.character;
      const end = lineOffsets[range.end.line] + range.end.character;
      return content.slice(start, end);
    },
    lineCount: lines.length,
    lineAt: (lineNum) => {
      const text = lines[lineNum];
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
    },
    getWordRangeAtPosition: (position, regex) => {
      const lineText = lines[position.line] || '';
      const char = position.character;
      let start = char;
      let end = char;
      const reg = regex || /[a-zA-Z0-9_]+/;
      while (start > 0 && reg.test(lineText.slice(start - 1, end))) {
        start--;
      }
      while (end < lineText.length && reg.test(lineText.slice(start, end + 1))) {
        end++;
      }
      if (start === end) return undefined;
      return new mockVscode.Range(position.line, start, position.line, end);
    }
  };
}

// Mock TextEditor helper
function createMockEditor(document, selection) {
  let docContent = document.getText();
  let currentDoc = document;

  const editor = {
    document: currentDoc,
    selection: selection,
    selections: selection ? [selection] : [],
    edit: async (callback) => {
      const edits = [];
      const editBuilder = {
        replace: (range, text) => {
          edits.push({ range, text });
        },
        insert: (pos, text) => {
          edits.push({ range: new mockVscode.Range(pos, pos), text });
        },
        delete: (range) => {
          edits.push({ range, text: '' });
        }
      };
      callback(editBuilder);

      // Apply edits line by line preserving line break style
      const eol = docContent.includes('\r\n') ? '\r\n' : '\n';
      const lines = docContent.split(/\r?\n/);
      for (const edit of edits) {
        lines[edit.range.start.line] = edit.text;
      }
      docContent = lines.join(eol);
      currentDoc = createMockDocument(docContent, document.uri.fsPath);
      editor.document = currentDoc;
      return true;
    }
  };

  return editor;
}

describe('QoL Requirements Suite', () => {

  // =========================================================================
  // R1: Non-Intrusive Autocomplete Triggering & Enter / Newline Protection
  // =========================================================================
  describe('R1: Non-Intrusive Autocomplete Triggering & Enter Protection', () => {

    it('R1.1: TRIGGER_CHARACTERS does not contain newline (\\n) or space ( )', () => {
      assert.ok(Array.isArray(TRIGGER_CHARACTERS), 'TRIGGER_CHARACTERS should be an array');
      assert.strictEqual(
        TRIGGER_CHARACTERS.includes('\n'),
        false,
        'TRIGGER_CHARACTERS must NOT include newline (\\n)'
      );
      assert.strictEqual(
        TRIGGER_CHARACTERS.includes(' '),
        false,
        'TRIGGER_CHARACTERS must NOT include space (" ")'
      );
    });

    it('R1.1: TRIGGER_CHARACTERS retains delimiters (. and () and alphanumeric typing', () => {
      assert.ok(TRIGGER_CHARACTERS.includes('.'), 'Must include dot delimiter');
      assert.ok(TRIGGER_CHARACTERS.includes('('), 'Must include parenthesis delimiter');
      assert.ok(TRIGGER_CHARACTERS.includes('s') && TRIGGER_CHARACTERS.includes('S'), 'Must include letters');
      assert.ok(TRIGGER_CHARACTERS.includes('0') && TRIGGER_CHARACTERS.includes('9'), 'Must include digits');
    });

    it('R1.2: Completion provider returns undefined on completely empty line inside SQL triple quotes', async () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);

      const code = `import duckdb\ncon = duckdb.connect()\ncon.sql("""\nSELECT *\n\nFROM lake_users\n""")`;
      const doc = createMockDocument(code);
      // Line 4 is empty: ""
      const pos = new mockVscode.Position(4, 0);

      const result = await provider.provideCompletionItems(doc, pos, {}, {});
      assert.strictEqual(result, undefined, 'Completion on empty line must return undefined (no suggestion trap)');
    });

    it('R1.2: Completion provider returns undefined on whitespace-only line inside SQL triple quotes', async () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);

      const code = `import duckdb\ncon = duckdb.connect()\ncon.sql("""\n    SELECT *\n    \n    FROM lake_users\n""")`;
      const doc = createMockDocument(code);
      // Line 4 has 4 spaces: "    "
      const pos = new mockVscode.Position(4, 4);

      const result = await provider.provideCompletionItems(doc, pos, {}, {});
      assert.strictEqual(result, undefined, 'Completion on whitespace-only line must return undefined');
    });

    it('R1.2: Completion provider provides suggestions when user types characters on an indented line', async () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);

      const code = `import duckdb\ncon = duckdb.connect()\ncon.sql("""\n    SELECT *\n    F\n""")`;
      const doc = createMockDocument(code);
      // Line 4 has "    F" with cursor after F
      const pos = new mockVscode.Position(4, 5);

      const result = await provider.provideCompletionItems(doc, pos, {}, {});
      assert.ok(result, 'Completion provider should return suggestions when user types characters');
      assert.ok(Array.isArray(result) && result.length > 0, 'Should return non-empty completions list');
    });

    it('R1.3: package.json contributes editor.acceptSuggestionOnEnter default set to "off" for [python]', () => {
      const pkgPath = path.join(__dirname, '../package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      const configDefaults = pkg.contributes?.configurationDefaults;
      assert.ok(configDefaults, 'package.json should have contributes.configurationDefaults');
      assert.ok(configDefaults['[python]'], 'Should configure [python] defaults');
      assert.strictEqual(
        configDefaults['[python]']['editor.acceptSuggestionOnEnter'],
        'off',
        'editor.acceptSuggestionOnEnter should default to "off" to allow Tab completion'
      );
    });

    it('R1.3: package.json declares ducklake.autocomplete.acceptSuggestionOnEnter configuration property', () => {
      const pkgPath = path.join(__dirname, '../package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      const props = pkg.contributes?.configuration?.properties;
      assert.ok(props['ducklake.autocomplete.acceptSuggestionOnEnter'], 'Property should be declared');
      assert.strictEqual(props['ducklake.autocomplete.acceptSuggestionOnEnter'].default, 'off');
    });
  });

  // =========================================================================
  // R2: Concise Window & Analytical Function Completions
  // =========================================================================
  describe('R2: Concise Window & Analytical Function Completions', () => {

    it('R2.1: dense_rank() inserts concise signature without OVER (PARTITION BY ...)', () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);
      const items = provider.getDuckDBColumnFunctions('0_');

      const denseRank = items.find(it => it.label === 'dense_rank()');
      assert.ok(denseRank, 'dense_rank() completion item should exist');
      assert.strictEqual(denseRank.insertText.value, 'dense_rank()');
      assert.ok(
        !denseRank.insertText.value.includes('OVER'),
        'dense_rank() must not force OVER clause'
      );
    });

    it('R2.1: row_number() inserts concise signature without forced OVER clause', () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);
      const items = provider.getDuckDBColumnFunctions('0_');

      const rowNum = items.find(it => it.label === 'row_number()');
      assert.ok(rowNum, 'row_number() completion item should exist');
      assert.strictEqual(rowNum.insertText.value, 'row_number()');
      assert.ok(!rowNum.insertText.value.includes('OVER'), 'row_number() must not force OVER');
    });

    it('R2.1: rank(), percent_rank(), cume_dist(), ntile() insert concise signatures', () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);
      const items = provider.getDuckDBColumnFunctions('0_');

      const rank = items.find(it => it.label === 'rank()');
      assert.strictEqual(rank.insertText.value, 'rank()');

      const pctRank = items.find(it => it.label === 'percent_rank()');
      assert.strictEqual(pctRank.insertText.value, 'percent_rank()');

      const cumeDist = items.find(it => it.label === 'cume_dist()');
      assert.strictEqual(cumeDist.insertText.value, 'cume_dist()');

      const ntile = items.find(it => it.label === 'ntile()');
      assert.strictEqual(ntile.insertText.value, 'ntile(${1:num_buckets})');
    });

    it('R2.1: lag(), lead(), first_value(), last_value() insert concise column placeholders without OVER', () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);
      const items = provider.getDuckDBColumnFunctions('0_');

      const lag = items.find(it => it.label === 'lag()');
      assert.strictEqual(lag.insertText.value, 'lag(${1:col})');

      const lead = items.find(it => it.label === 'lead()');
      assert.strictEqual(lead.insertText.value, 'lead(${1:col})');

      const firstVal = items.find(it => it.label === 'first_value()');
      assert.strictEqual(firstVal.insertText.value, 'first_value(${1:col})');

      const lastVal = items.find(it => it.label === 'last_value()');
      assert.strictEqual(lastVal.insertText.value, 'last_value(${1:col})');

      const nthVal = items.find(it => it.label === 'nth_value()');
      assert.strictEqual(nthVal.insertText.value, 'nth_value(${1:col}, ${2:1})');
    });

    it('R2.2: Standard SQL keywords OVER, PARTITION BY, WINDOW, QUALIFY are preserved in keyword catalog', () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);
      const keywords = provider.getSqlKeywords('0_');
      const labels = keywords.map(kw => kw.label);

      assert.ok(labels.includes('OVER'), 'Keyword OVER must be preserved');
      assert.ok(labels.includes('PARTITION BY'), 'Keyword PARTITION BY must be preserved');
      assert.ok(labels.includes('WINDOW'), 'Keyword WINDOW must be preserved');
      assert.ok(labels.includes('QUALIFY'), 'Keyword QUALIFY must be preserved');
    });
  });

  // =========================================================================
  // R3: Context-Aware SQL Line Commenting (Ctrl+/)
  // =========================================================================
  describe('R3: Context-Aware SQL Line Commenting (ducklake.toggleComment)', () => {

    it('R3.1: toggleSqlLineComment correctly prepends and strips "-- "', () => {
      assert.strictEqual(toggleSqlLineComment('SELECT 1', false), '-- SELECT 1');
      assert.strictEqual(toggleSqlLineComment('-- SELECT 1', true), 'SELECT 1');

      // Preserving indentation
      assert.strictEqual(toggleSqlLineComment('    SELECT 1', false), '    -- SELECT 1');
      assert.strictEqual(toggleSqlLineComment('    -- SELECT 1', true), '    SELECT 1');

      // Without space after --
      assert.strictEqual(toggleSqlLineComment('    --SELECT 1', true), '    SELECT 1');
    });

    it('R3.1: isSqlCommented correctly identifies SQL comments', () => {
      assert.strictEqual(isSqlCommented('-- SELECT 1'), true);
      assert.strictEqual(isSqlCommented('    -- SELECT 1'), true);
      assert.strictEqual(isSqlCommented('    --SELECT 1'), true);
      assert.strictEqual(isSqlCommented('SELECT 1'), false);
      assert.strictEqual(isSqlCommented('    SELECT 1'), false);
      assert.strictEqual(isSqlCommented('# SELECT 1'), false);
    });

    it('R3.1: Toggles "-- " on and off for active line inside Python SQL block', async () => {
      const code = `con.sql("""\n    SELECT id, name\n    FROM lake_users\n""")`;
      const doc = createMockDocument(code);
      const selection = new mockVscode.Selection(
        new mockVscode.Position(1, 4),
        new mockVscode.Position(1, 4)
      );
      const editor = createMockEditor(doc, selection);

      // Step 1: Toggle comment ON
      const handled1 = await toggleCommentCommand(editor);
      assert.strictEqual(handled1, true, 'Should be handled as SQL comment');
      assert.strictEqual(
        editor.document.lineAt(1).text,
        '    -- SELECT id, name',
        'Should comment line with "-- "'
      );

      // Step 2: Toggle comment OFF
      const handled2 = await toggleCommentCommand(editor);
      assert.strictEqual(handled2, true, 'Should be handled as SQL comment');
      assert.strictEqual(
        editor.document.lineAt(1).text,
        '    SELECT id, name',
        'Should uncomment line back to original text'
      );
    });

    it('R3.1: Toggles "-- " on multi-line selection inside SQL block', async () => {
      const code = `con.sql("""\n    SELECT id\n    FROM lake_users\n""")`;
      const doc = createMockDocument(code);
      const selection = new mockVscode.Selection(
        new mockVscode.Position(1, 4),
        new mockVscode.Position(2, 8)
      );
      const editor = createMockEditor(doc, selection);

      // Toggle ON
      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '    -- SELECT id');
      assert.strictEqual(editor.document.lineAt(2).text, '    -- FROM lake_users');

      // Toggle OFF
      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '    SELECT id');
      assert.strictEqual(editor.document.lineAt(2).text, '    FROM lake_users');
    });

    it('R3.2: Delegates to editor.action.commentLine when cursor is outside SQL block', async () => {
      let delegatedCommand = null;
      mockVscode.commands.executeCommand = async (cmd) => {
        delegatedCommand = cmd;
      };

      const code = `x = 10\ny = 20\ncon.sql("""\nSELECT 1\n""")`;
      const doc = createMockDocument(code);
      const selection = new mockVscode.Selection(
        new mockVscode.Position(0, 2),
        new mockVscode.Position(0, 2)
      );
      const editor = createMockEditor(doc, selection);

      const handled = await toggleCommentCommand(editor);
      assert.strictEqual(handled, false, 'Should NOT handle as SQL comment');
      assert.strictEqual(
        delegatedCommand,
        'editor.action.commentLine',
        'Should delegate to VS Code default commentLine for Python code'
      );
    });

    it('R3.2: Delegates to editor.action.commentLine on Python line containing opening triple quotes', async () => {
      let delegatedCommand = null;
      mockVscode.commands.executeCommand = async (cmd) => {
        delegatedCommand = cmd;
      };

      const code = `con.sql("""\nSELECT 1\n""")`;
      const doc = createMockDocument(code);
      // Line 0 is 'con.sql("""'
      const selection = new mockVscode.Selection(
        new mockVscode.Position(0, 2),
        new mockVscode.Position(0, 2)
      );
      const editor = createMockEditor(doc, selection);

      const handled = await toggleCommentCommand(editor);
      assert.strictEqual(handled, false, 'Should NOT handle line 0 as pure SQL');
      assert.strictEqual(delegatedCommand, 'editor.action.commentLine');
    });

    it('R3.3: Supports Jupyter notebook cells (.ipynb)', async () => {
      const code = `con.sql("""\nSELECT total_sales\nFROM lake_orders\n""")`;
      // Jupyter notebook cell document
      const doc = createMockDocument(code, 'vscode-notebook-cell:/c:/project/notebook.ipynb#W0sZmlsZQ==');
      const selection = new mockVscode.Selection(
        new mockVscode.Position(1, 2),
        new mockVscode.Position(1, 2)
      );
      const editor = createMockEditor(doc, selection);

      const handled = await toggleCommentCommand(editor);
      assert.strictEqual(handled, true, 'Should handle SQL commenting inside notebook cells');
      assert.strictEqual(editor.document.lineAt(1).text, '-- SELECT total_sales');
    });

    it('R3.3: package.json registers ducklake.toggleComment command and Ctrl+/ / Cmd+/ keybinding', () => {
      const pkgPath = path.join(__dirname, '../package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

      const cmd = pkg.contributes?.commands?.find(c => c.command === 'ducklake.toggleComment');
      assert.ok(cmd, 'ducklake.toggleComment command must be registered');

      const keybinding = pkg.contributes?.keybindings?.find(k => k.command === 'ducklake.toggleComment');
      assert.ok(keybinding, 'Keybinding for ducklake.toggleComment must exist');
      assert.strictEqual(keybinding.key.toLowerCase(), 'ctrl+/');
      assert.strictEqual(keybinding.mac?.toLowerCase(), 'cmd+/');
      assert.ok(
        keybinding.when.includes('editorLangId == python') || keybinding.when.includes('python'),
        'Keybinding when condition must cover Python/Notebook editors'
      );
    });
  });

  // =========================================================================
  // Edge Cases & Robustness
  // =========================================================================
  describe('Edge Cases & Robustness', () => {

    it('Edge: Mixed commented and uncommented lines harmonizes (comments all, then uncomments all)', async () => {
      const code = `con.sql("""\n    -- SELECT 1\n    SELECT 2\n""")`;
      const doc = createMockDocument(code);
      const selection = new mockVscode.Selection(
        new mockVscode.Position(1, 4),
        new mockVscode.Position(2, 4)
      );
      const editor = createMockEditor(doc, selection);

      // Step 1: Mixed -> comments uncommented lines so all become commented
      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '    -- SELECT 1');
      assert.strictEqual(editor.document.lineAt(2).text, '    -- SELECT 2');

      // Step 2: All commented -> uncomments all
      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '    SELECT 1');
      assert.strictEqual(editor.document.lineAt(2).text, '    SELECT 2');
    });

    it('Edge: Commenting single empty line inside SQL block inserts "-- "', async () => {
      const code = `con.sql("""\n\nSELECT 1\n""")`;
      const doc = createMockDocument(code);
      const selection = new mockVscode.Selection(
        new mockVscode.Position(1, 0),
        new mockVscode.Position(1, 0)
      );
      const editor = createMockEditor(doc, selection);

      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '-- ');

      // Toggling again removes it
      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '');
    });

    it('Edge: Tab-indented SQL lines preserve tab indentation when toggling comments', () => {
      const tabbed = '\t\tSELECT 1';
      const commented = toggleSqlLineComment(tabbed, false);
      assert.strictEqual(commented, '\t\t-- SELECT 1');

      const uncommented = toggleSqlLineComment(commented, true);
      assert.strictEqual(uncommented, '\t\tSELECT 1');
    });

    it('Edge: No active editor returns false cleanly without error', async () => {
      const result = await toggleCommentCommand(undefined);
      assert.strictEqual(result, false);
    });

    it('Edge: Cursor on closing triple quote line delegates to Python comment (#)', async () => {
      let delegatedCommand = null;
      mockVscode.commands.executeCommand = async (cmd) => {
        delegatedCommand = cmd;
      };

      const code = `con.sql("""\nSELECT 1\n""")`;
      const doc = createMockDocument(code);
      const selection = new mockVscode.Selection(
        new mockVscode.Position(2, 0),
        new mockVscode.Position(2, 0)
      );
      const editor = createMockEditor(doc, selection);

      const handled = await toggleCommentCommand(editor);
      assert.strictEqual(handled, false);
      assert.strictEqual(delegatedCommand, 'editor.action.commentLine');
    });

    it('Edge: Multiple cursors toggle comments across all target lines inside SQL block', async () => {
      const code = `con.sql("""\n    SELECT a\n    SELECT b\n    SELECT c\n""")`;
      const doc = createMockDocument(code);
      const editor = createMockEditor(doc, new mockVscode.Selection(new mockVscode.Position(1, 4), new mockVscode.Position(1, 4)));
      editor.selections = [
        new mockVscode.Selection(new mockVscode.Position(1, 4), new mockVscode.Position(1, 4)),
        new mockVscode.Selection(new mockVscode.Position(3, 4), new mockVscode.Position(3, 4))
      ];

      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '    -- SELECT a');
      assert.strictEqual(editor.document.lineAt(2).text, '    SELECT b');
      assert.strictEqual(editor.document.lineAt(3).text, '    -- SELECT c');
    });

    it('Edge: Editor without selection or undefined selection returns false cleanly without error', async () => {
      const code = `con.sql("""\nSELECT 1\n""")`;
      const doc = createMockDocument(code);
      const editor = { document: doc, selection: undefined, selections: [] };

      const result = await toggleCommentCommand(editor);
      assert.strictEqual(result, false, 'Should safely return false when editor.selection is undefined');
    });

    it('Edge: Editor with undefined selections array falls back to primary selection cleanly', async () => {
      const code = `con.sql("""\n    SELECT 100\n""")`;
      const doc = createMockDocument(code);
      const sel = new mockVscode.Selection(new mockVscode.Position(1, 4), new mockVscode.Position(1, 4));
      const editor = createMockEditor(doc, sel);
      delete editor.selections; // delete selections array to test fallback

      const handled = await toggleCommentCommand(editor);
      assert.strictEqual(handled, true);
      assert.strictEqual(editor.document.lineAt(1).text, '    -- SELECT 100');
    });

    it('Edge: isLineInsideSqlRange handles negative or out-of-bounds line index safely returning false', () => {
      const code = `con.sql("""\nSELECT 1\n""")`;
      const doc = createMockDocument(code);

      assert.strictEqual(isLineInsideSqlRange(doc, -1, 11, 20), false);
      assert.strictEqual(isLineInsideSqlRange(doc, 999, 11, 20), false);
      assert.strictEqual(isLineInsideSqlRange(null, 1, 11, 20), false);
    });

    it('Edge: Delegating commentLine survives executeCommand throwing an error cleanly', async () => {
      mockVscode.commands.executeCommand = async () => {
        throw new Error('Simulated executeCommand failure');
      };

      const code = `x = 42`;
      const doc = createMockDocument(code);
      const sel = new mockVscode.Selection(new mockVscode.Position(0, 0), new mockVscode.Position(0, 0));
      const editor = createMockEditor(doc, sel);

      const handled = await toggleCommentCommand(editor);
      assert.strictEqual(handled, false, 'Should catch and return false cleanly without throwing');
    });

    it('Edge: Autocomplete provider returns undefined when line contains tabs-only whitespace', async () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);

      const code = `con.sql("""\n\t\t\nSELECT 1\n""")`;
      const doc = createMockDocument(code);
      const pos = new mockVscode.Position(1, 2);

      const result = await provider.provideCompletionItems(doc, pos, {}, {});
      assert.strictEqual(result, undefined, 'Tabs-only line must return undefined');
    });

    it('Edge: Autocomplete provider returns undefined when cursor is at line character 0', async () => {
      const schemaManager = createMockSchemaManager();
      const provider = new DuckLakeCompletionProvider(schemaManager);

      const code = `con.sql("""\nSELECT 1\n""")`;
      const doc = createMockDocument(code);
      const pos = new mockVscode.Position(1, 0);

      const result = await provider.provideCompletionItems(doc, pos, {}, {});
      assert.strictEqual(result, undefined, 'Cursor at column 0 must return undefined');
    });

    it('Edge: SQL line commenting works cleanly with CRLF line breaks and preserves indent', async () => {
      const code = 'con.sql("""\r\n    SELECT col_a,\r\n    col_b\r\n""")';
      const doc = createMockDocument(code);
      const sel = new mockVscode.Selection(new mockVscode.Position(1, 4), new mockVscode.Position(2, 4));
      const editor = createMockEditor(doc, sel);

      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '    -- SELECT col_a,');
      assert.strictEqual(editor.document.lineAt(2).text, '    -- col_b');

      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '    SELECT col_a,');
      assert.strictEqual(editor.document.lineAt(2).text, '    col_b');
    });

    it('Edge: Multi-line selection containing blank lines preserves blank lines while commenting non-blank', async () => {
      const code = `con.sql("""\n    SELECT 1\n    \n    SELECT 2\n""")`;
      const doc = createMockDocument(code);
      const sel = new mockVscode.Selection(new mockVscode.Position(1, 4), new mockVscode.Position(3, 4));
      const editor = createMockEditor(doc, sel);

      await toggleCommentCommand(editor);
      assert.strictEqual(editor.document.lineAt(1).text, '    -- SELECT 1');
      assert.strictEqual(editor.document.lineAt(2).text, '    ');
      assert.strictEqual(editor.document.lineAt(3).text, '    -- SELECT 2');
    });

    it('Edge: editor.edit returning false propagates false cleanly', async () => {
      const code = `con.sql("""\n    SELECT 1\n""")`;
      const doc = createMockDocument(code);
      const sel = new mockVscode.Selection(new mockVscode.Position(1, 4), new mockVscode.Position(1, 4));
      const editor = createMockEditor(doc, sel);
      editor.edit = async () => false;

      const result = await toggleCommentCommand(editor);
      assert.strictEqual(result, false, 'Should return false when editor.edit fails');
    });

    it('Edge: Python code between two docstrings or strings is NOT falsely detected as SQL', async () => {
      let delegatedCommand = null;
      mockVscode.commands.executeCommand = async (cmd) => {
        delegatedCommand = cmd;
      };

      const code = `doc = """Some module docstring"""\n\ndef get_user():\n    from datetime import datetime\n    return datetime.now()\n\nquery = """\nSELECT * FROM users\n"""`;
      const doc = createMockDocument(code);
      // Line 3: "    from datetime import datetime" (contains "from" which previously tripped naive heuristic)
      const sel = new mockVscode.Selection(new mockVscode.Position(3, 4), new mockVscode.Position(3, 4));
      const editor = createMockEditor(doc, sel);

      const handled = await toggleCommentCommand(editor);
      assert.strictEqual(handled, false, 'Python code between docstrings must NOT be treated as SQL');
      assert.strictEqual(delegatedCommand, 'editor.action.commentLine', 'Must delegate to Python commentLine');
    });

    it('Edge: Single-quoted string gap with SQL keywords is NOT falsely detected as SQL', async () => {
      let delegatedCommand = null;
      mockVscode.commands.executeCommand = async (cmd) => {
        delegatedCommand = cmd;
      };

      const code = `s1 = "hello"\nSELECT = 1\ns2 = "world"`;
      const doc = createMockDocument(code);
      // Line 1: "SELECT = 1" (outside strings)
      const sel = new mockVscode.Selection(new mockVscode.Position(1, 2), new mockVscode.Position(1, 2));
      const editor = createMockEditor(doc, sel);

      const handled = await toggleCommentCommand(editor);
      assert.strictEqual(handled, false);
      assert.strictEqual(delegatedCommand, 'editor.action.commentLine');
    });

    it('Edge: Python comment containing quote characters does not disrupt SQL detection', async () => {
      let delegatedCommand = null;
      mockVscode.commands.executeCommand = async (cmd) => {
        delegatedCommand = cmd;
      };

      const code = `# Don't run this directly\nATTACH = True\n# Can't change settings`;
      const doc = createMockDocument(code);
      const sel = new mockVscode.Selection(new mockVscode.Position(1, 0), new mockVscode.Position(1, 0));
      const editor = createMockEditor(doc, sel);

      const handled = await toggleCommentCommand(editor);
      assert.strictEqual(handled, false, 'Python code around comments with quotes must delegate to Python');
      assert.strictEqual(delegatedCommand, 'editor.action.commentLine');
    });
  });
});

