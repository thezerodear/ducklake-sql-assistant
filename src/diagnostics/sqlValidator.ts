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

export type TokenType =
  | 'WHITESPACE'
  | 'COMMENT'
  | 'STRING'
  | 'UNCLOSED_STRING'
  | 'QUOTED_IDENT'
  | 'UNCLOSED_QUOTED_IDENT'
  | 'INTERPOLATION'
  | 'IDENTIFIER'
  | 'KEYWORD'
  | 'NUMBER'
  | 'OPERATOR'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'DOT'
  | 'SEMICOLON';

export interface SqlToken {
  type: TokenType;
  text: string;
  start: number;
  end: number;
}

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'FULL', 'CROSS', 'OUTER', 'NATURAL', 'ON', 'USING',
  'WITH', 'RECURSIVE', 'AS', 'UNION', 'ALL', 'DISTINCT', 'INTERSECT', 'EXCEPT',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TABLE', 'VIEW',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'ILIKE',
  'BETWEEN', 'EXISTS', 'WINDOW', 'OVER', 'PARTITION', 'QUALIFY', 'FILTER', 'EXCLUDE', 'REPLACE',
  'ATTACH', 'DETACH', 'PRAGMA', 'COPY', 'DESCRIBE', 'EXPLAIN', 'SHOW', 'USE', 'TRUNCATE'
]);

const CLAUSE_BOUNDARY_KEYWORDS = new Set([
  'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'WINDOW', 'QUALIFY',
  'JOIN', 'UNION', 'INTERSECT', 'EXCEPT', 'SET', 'VALUES'
]);

const JOIN_MODIFIERS = new Set(['LEFT', 'RIGHT', 'INNER', 'CROSS', 'FULL']);

function isClauseBoundaryKeyword(token: SqlToken | null, followingToken: SqlToken | null): boolean {
  if (!token || token.type !== 'KEYWORD') {
    return false;
  }
  if (followingToken && followingToken.type === 'LPAREN') {
    return false;
  }
  return CLAUSE_BOUNDARY_KEYWORDS.has(token.text.toUpperCase());
}

const BINARY_OPERATORS = new Set([
  '=', '!=', '<>', '<', '>', '<=', '>=', '==',
  'AND', 'OR', 'LIKE', 'ILIKE', 'IS', 'IN', '+', '-', '*', '/', '%', '||'
]);

export class SqlTokenizer {
  public static tokenize(sql: string): { tokens: SqlToken[]; unclosedQuoteErrors: { message: string; start: number; end: number }[] } {
    const tokens: SqlToken[] = [];
    const unclosedQuoteErrors: { message: string; start: number; end: number }[] = [];
    const n = sql.length;
    let pos = 0;

    while (pos < n) {
      const ch = sql[pos];

      // Whitespace
      if (/\s/.test(ch)) {
        const start = pos;
        while (pos < n && /\s/.test(sql[pos])) {
          pos++;
        }
        tokens.push({ type: 'WHITESPACE', text: sql.slice(start, pos), start, end: pos });
        continue;
      }

      // Single-line comment --
      if (ch === '-' && pos + 1 < n && sql[pos + 1] === '-') {
        const start = pos;
        pos += 2;
        while (pos < n && sql[pos] !== '\n') {
          pos++;
        }
        tokens.push({ type: 'COMMENT', text: sql.slice(start, pos), start, end: pos });
        continue;
      }

      // Block comment /* ... */ (supports nested block comments in DuckDB)
      if (ch === '/' && pos + 1 < n && sql[pos + 1] === '*') {
        const start = pos;
        pos += 2;
        let closed = false;
        let depth = 1;
        while (pos + 1 < n) {
          if (sql[pos] === '/' && sql[pos + 1] === '*') {
            depth++;
            pos += 2;
            continue;
          }
          if (sql[pos] === '*' && sql[pos + 1] === '/') {
            depth--;
            pos += 2;
            if (depth === 0) {
              closed = true;
              break;
            }
            continue;
          }
          pos++;
        }
        if (!closed) {
          unclosedQuoteErrors.push({
            message: 'Unclosed block comment starting with /*',
            start,
            end: n
          });
          pos = n;
        }
        tokens.push({ type: 'COMMENT', text: sql.slice(start, pos), start, end: pos });
        continue;
      }

      // Python f-string interpolation {expr}
      if (ch === '{') {
        const start = pos;
        pos++;
        let depth = 1;
        while (pos < n && depth > 0) {
          if (sql[pos] === '{') depth++;
          else if (sql[pos] === '}') depth--;
          pos++;
        }
        tokens.push({ type: 'INTERPOLATION', text: sql.slice(start, pos), start, end: pos });
        continue;
      }

      // String literal '...'
      if (ch === "'") {
        const start = pos;
        pos++;
        let closed = false;

        while (pos < n) {
          if (sql[pos] === '\\') {
            // Python escaped quote or character
            pos += 2;
            continue;
          }
          if (sql[pos] === "'") {
            if (pos + 1 < n && sql[pos + 1] === "'") {
              // SQL doubled quote ''
              pos += 2;
              continue;
            }
            pos++;
            closed = true;
            break;
          }
          pos++;
        }

        if (!closed) {
          const errEnd = Math.min(n, start + (sql.slice(start).indexOf('\n') !== -1 ? sql.slice(start).indexOf('\n') : n - start));
          unclosedQuoteErrors.push({
            message: "Unclosed string literal starting with '",
            start,
            end: errEnd > start ? errEnd : n
          });
          tokens.push({ type: 'UNCLOSED_STRING', text: sql.slice(start, pos), start, end: pos });
        } else {
          tokens.push({ type: 'STRING', text: sql.slice(start, pos), start, end: pos });
        }
        continue;
      }

      // Quoted identifier "..." or `...`
      if (ch === '"' || ch === '`') {
        const quoteChar = ch;
        const start = pos;
        pos++;
        let closed = false;

        while (pos < n) {
          if (sql[pos] === '\\') {
            pos += 2;
            continue;
          }
          if (sql[pos] === quoteChar) {
            pos++;
            closed = true;
            break;
          }
          if (sql[pos] === '\n') {
            break;
          }
          pos++;
        }

        if (!closed) {
          const errEnd = Math.min(n, start + (sql.slice(start).indexOf('\n') !== -1 ? sql.slice(start).indexOf('\n') : n - start));
          unclosedQuoteErrors.push({
            message: `Unclosed quoted identifier starting with ${quoteChar}`,
            start,
            end: errEnd > start ? errEnd : n
          });
          tokens.push({ type: 'UNCLOSED_QUOTED_IDENT', text: sql.slice(start, pos), start, end: pos });
        } else {
          tokens.push({ type: 'QUOTED_IDENT', text: sql.slice(start, pos), start, end: pos });
        }
        continue;
      }

      // Punctuations
      if (ch === '(') {
        tokens.push({ type: 'LPAREN', text: ch, start: pos, end: pos + 1 });
        pos++;
        continue;
      }
      if (ch === ')') {
        tokens.push({ type: 'RPAREN', text: ch, start: pos, end: pos + 1 });
        pos++;
        continue;
      }
      if (ch === ',') {
        tokens.push({ type: 'COMMA', text: ch, start: pos, end: pos + 1 });
        pos++;
        continue;
      }
      if (ch === ';') {
        tokens.push({ type: 'SEMICOLON', text: ch, start: pos, end: pos + 1 });
        pos++;
        continue;
      }
      if (ch === '.') {
        tokens.push({ type: 'DOT', text: ch, start: pos, end: pos + 1 });
        pos++;
        continue;
      }

      // Multi-char operators
      if (
        (ch === '!' && pos + 1 < n && sql[pos + 1] === '=') ||
        (ch === '<' && pos + 1 < n && (sql[pos + 1] === '>' || sql[pos + 1] === '=')) ||
        (ch === '>' && pos + 1 < n && sql[pos + 1] === '=') ||
        (ch === '=' && pos + 1 < n && sql[pos + 1] === '=') ||
        (ch === '|' && pos + 1 < n && sql[pos + 1] === '|')
      ) {
        tokens.push({ type: 'OPERATOR', text: sql.slice(pos, pos + 2), start: pos, end: pos + 2 });
        pos += 2;
        continue;
      }

      // Single-char operators
      if (['=', '<', '>', '+', '-', '*', '/', '%'].includes(ch)) {
        tokens.push({ type: 'OPERATOR', text: ch, start: pos, end: pos + 1 });
        pos++;
        continue;
      }

      // Numbers
      if (/\d/.test(ch)) {
        const start = pos;
        while (pos < n && /[\d.]/.test(sql[pos])) {
          pos++;
        }
        tokens.push({ type: 'NUMBER', text: sql.slice(start, pos), start, end: pos });
        continue;
      }

      // Identifiers and Keywords (including Thai Unicode)
      if (/[a-zA-Z_\u0E00-\u0E7F]/.test(ch)) {
        const start = pos;
        while (pos < n && /[a-zA-Z0-9_\u0E00-\u0E7F]/.test(sql[pos])) {
          pos++;
        }
        const text = sql.slice(start, pos);
        const upper = text.toUpperCase();
        if (SQL_KEYWORDS.has(upper)) {
          tokens.push({ type: 'KEYWORD', text, start, end: pos });
        } else {
          tokens.push({ type: 'IDENTIFIER', text, start, end: pos });
        }
        continue;
      }

      // Parameter markers (?)
      if (ch === '?') {
        const start = pos;
        pos++;
        while (pos < n && /\d/.test(sql[pos])) {
          pos++;
        }
        tokens.push({ type: 'IDENTIFIER', text: sql.slice(start, pos), start, end: pos });
        continue;
      }

      // Any other characters (e.g. colon, brackets, unrecognized)
      pos++;
    }

    return { tokens, unclosedQuoteErrors };
  }
}

import { SchemaValidator } from './schemaValidator';

export class SqlValidator implements ISqlValidator {
  public validateSql(
    document: vscode.TextDocument,
    sqlBlock: { text: string; startOffset: number; endOffset: number },
    options: SqlValidationOptions
  ): SqlDiagnosticItem[] {
    const diagnostics: SqlDiagnosticItem[] = [];

    if (options.checkSyntax !== false) {
      diagnostics.push(...this.validateSyntax(document, sqlBlock));
    }

    if (options.checkSchema && options.isCatalogConnected && options.catalogTables) {
      diagnostics.push(...SchemaValidator.validateSchemaWithTables(
        document,
        sqlBlock,
        options.catalogTables,
        options.isCatalogConnected
      ));
    }

    return diagnostics;
  }

  public validateSyntax(
    document: vscode.TextDocument,
    sqlBlock: { text: string; startOffset: number; endOffset: number }
  ): SqlDiagnosticItem[] {
    const diagnostics: SqlDiagnosticItem[] = [];
    const { tokens, unclosedQuoteErrors } = SqlTokenizer.tokenize(sqlBlock.text);

    // 1. Report unclosed quote errors
    for (const err of unclosedQuoteErrors) {
      const range = this.toDocRange(document, sqlBlock.startOffset, err.start, err.end);
      diagnostics.push({
        range,
        message: err.message,
        severity: vscode.DiagnosticSeverity.Error
      });
    }

    // Filter non-trivia tokens for syntax analysis
    const nonTrivia: SqlToken[] = tokens.filter(
      t => t.type !== 'WHITESPACE' && t.type !== 'COMMENT'
    );

    // 2. Parentheses balancing check
    const parenStack: { start: number; end: number }[] = [];
    for (const token of nonTrivia) {
      if (token.type === 'LPAREN') {
        parenStack.push({ start: token.start, end: token.end });
      } else if (token.type === 'RPAREN') {
        if (parenStack.length === 0) {
          diagnostics.push({
            range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
            message: "Unmatched closing parenthesis ')'",
            severity: vscode.DiagnosticSeverity.Error
          });
        } else {
          parenStack.pop();
        }
      }
    }

    while (parenStack.length > 0) {
      const unclosed = parenStack.pop()!;
      diagnostics.push({
        range: this.toDocRange(document, sqlBlock.startOffset, unclosed.start, unclosed.end),
        message: "Unclosed parenthesis '('",
        severity: vscode.DiagnosticSeverity.Error
      });
    }

    // 3. Trailing commas, incomplete clauses, and dangling operators
    const len = nonTrivia.length;

    for (let i = 0; i < len; i++) {
      const token = nonTrivia[i];
      const nextToken = i + 1 < len ? nonTrivia[i + 1] : null;

      // --- Trailing Commas ---
      if (token.type === 'COMMA') {
        if (!nextToken || nextToken.type === 'SEMICOLON') {
          diagnostics.push({
            range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
            message: 'Trailing comma at end of query',
            severity: vscode.DiagnosticSeverity.Error
          });
        } else if (nextToken.type === 'RPAREN') {
          diagnostics.push({
            range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
            message: "Trailing comma before ')'",
            severity: vscode.DiagnosticSeverity.Error
          });
        } else if (nextToken.type === 'KEYWORD') {
          const kw = nextToken.text.toUpperCase();
          const afterNext = i + 2 < len ? nonTrivia[i + 2] : null;
          const isNextFunc = afterNext && afterNext.type === 'LPAREN';
          if (!isNextFunc && (CLAUSE_BOUNDARY_KEYWORDS.has(kw) || kw === 'SELECT')) {
            let label = kw;
            if (kw === 'GROUP' || kw === 'ORDER') {
              if (afterNext && afterNext.text.toUpperCase() === 'BY') {
                label = `${kw} BY`;
              }
            }
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: `Trailing comma before '${label}'`,
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        }
        continue;
      }

      // --- Incomplete Clauses ---
      if (token.type === 'KEYWORD') {
        const kw = token.text.toUpperCase();

        if (kw === 'SELECT') {
          // Check what follows SELECT (skip DISTINCT / ALL)
          let targetNext = nextToken;
          let targetIndex = i + 1;
          if (targetNext && (targetNext.text.toUpperCase() === 'DISTINCT' || targetNext.text.toUpperCase() === 'ALL')) {
            targetIndex++;
            targetNext = targetIndex < len ? nonTrivia[targetIndex] : null;
          }
          const afterTarget = targetIndex + 1 < len ? nonTrivia[targetIndex + 1] : null;
          if (
            !targetNext ||
            targetNext.type === 'SEMICOLON' ||
            targetNext.type === 'RPAREN' ||
            isClauseBoundaryKeyword(targetNext, afterTarget)
          ) {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'SELECT' missing expressions",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (kw === 'FROM') {
          const afterNext = i + 2 < len ? nonTrivia[i + 2] : null;
          if (
            !nextToken ||
            nextToken.type === 'SEMICOLON' ||
            nextToken.type === 'RPAREN' ||
            (nextToken.type === 'KEYWORD' && nextToken.text.toUpperCase() === 'ON') ||
            isClauseBoundaryKeyword(nextToken, afterNext)
          ) {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'FROM' missing table reference",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (kw === 'WHERE') {
          const afterNext = i + 2 < len ? nonTrivia[i + 2] : null;
          if (
            !nextToken ||
            nextToken.type === 'SEMICOLON' ||
            nextToken.type === 'RPAREN' ||
            isClauseBoundaryKeyword(nextToken, afterNext)
          ) {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'WHERE' missing condition",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (kw === 'HAVING') {
          const afterNext = i + 2 < len ? nonTrivia[i + 2] : null;
          if (
            !nextToken ||
            nextToken.type === 'SEMICOLON' ||
            nextToken.type === 'RPAREN' ||
            isClauseBoundaryKeyword(nextToken, afterNext)
          ) {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'HAVING' missing condition",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (kw === 'GROUP') {
          if (nextToken && nextToken.text.toUpperCase() === 'BY') {
            const afterBy = i + 2 < len ? nonTrivia[i + 2] : null;
            const afterAfterBy = i + 3 < len ? nonTrivia[i + 3] : null;
            if (
              !afterBy ||
              afterBy.type === 'SEMICOLON' ||
              afterBy.type === 'RPAREN' ||
              isClauseBoundaryKeyword(afterBy, afterAfterBy)
            ) {
              diagnostics.push({
                range: this.toDocRange(document, sqlBlock.startOffset, token.start, nextToken.end),
                message: "Incomplete clause: 'GROUP BY' missing expressions",
                severity: vscode.DiagnosticSeverity.Error
              });
            }
          } else {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'GROUP' missing 'BY'",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (kw === 'ORDER') {
          if (nextToken && nextToken.text.toUpperCase() === 'BY') {
            const afterBy = i + 2 < len ? nonTrivia[i + 2] : null;
            const afterAfterBy = i + 3 < len ? nonTrivia[i + 3] : null;
            if (
              !afterBy ||
              afterBy.type === 'SEMICOLON' ||
              afterBy.type === 'RPAREN' ||
              isClauseBoundaryKeyword(afterBy, afterAfterBy)
            ) {
              diagnostics.push({
                range: this.toDocRange(document, sqlBlock.startOffset, token.start, nextToken.end),
                message: "Incomplete clause: 'ORDER BY' missing expressions",
                severity: vscode.DiagnosticSeverity.Error
              });
            }
          } else {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'ORDER' missing 'BY'",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (JOIN_MODIFIERS.has(kw)) {
          if (nextToken && nextToken.type === 'LPAREN') {
            continue;
          }
          const prevToken = i > 0 ? nonTrivia[i - 1] : null;
          if (prevToken && prevToken.type === 'KEYWORD' && prevToken.text.toUpperCase() === 'FROM') {
            continue;
          }

          let hasJoin = false;
          if (nextToken && nextToken.text.toUpperCase() === 'JOIN') {
            hasJoin = true;
          } else if (nextToken && nextToken.text.toUpperCase() === 'OUTER') {
            const afterOuter = i + 2 < len ? nonTrivia[i + 2] : null;
            if (afterOuter && afterOuter.text.toUpperCase() === 'JOIN') {
              hasJoin = true;
            }
          }

          if (!hasJoin) {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: `Incomplete clause: '${kw}' missing 'JOIN'`,
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (kw === 'JOIN') {
          const afterNext = i + 2 < len ? nonTrivia[i + 2] : null;
          if (
            !nextToken ||
            nextToken.type === 'SEMICOLON' ||
            nextToken.type === 'RPAREN' ||
            (nextToken.type === 'KEYWORD' && (nextToken.text.toUpperCase() === 'ON' || nextToken.text.toUpperCase() === 'USING')) ||
            isClauseBoundaryKeyword(nextToken, afterNext)
          ) {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'JOIN' missing table reference",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (kw === 'ON') {
          const afterNext = i + 2 < len ? nonTrivia[i + 2] : null;
          if (
            !nextToken ||
            nextToken.type === 'SEMICOLON' ||
            nextToken.type === 'RPAREN' ||
            isClauseBoundaryKeyword(nextToken, afterNext)
          ) {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'ON' missing condition",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (kw === 'LIMIT') {
          const afterNext = i + 2 < len ? nonTrivia[i + 2] : null;
          if (
            !nextToken ||
            nextToken.type === 'SEMICOLON' ||
            nextToken.type === 'RPAREN' ||
            isClauseBoundaryKeyword(nextToken, afterNext)
          ) {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'LIMIT' missing count",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        } else if (kw === 'SET') {
          const afterNext = i + 2 < len ? nonTrivia[i + 2] : null;
          if (
            !nextToken ||
            nextToken.type === 'SEMICOLON' ||
            nextToken.type === 'RPAREN' ||
            isClauseBoundaryKeyword(nextToken, afterNext)
          ) {
            diagnostics.push({
              range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
              message: "Incomplete clause: 'SET' missing assignments",
              severity: vscode.DiagnosticSeverity.Error
            });
          }
        }
      }

      // --- Dangling Operators ---
      const opText = token.text.toUpperCase();
      const isBinaryOp = token.type === 'OPERATOR' ? BINARY_OPERATORS.has(opText) : (token.type === 'KEYWORD' && BINARY_OPERATORS.has(opText));

      if (isBinaryOp) {
        // Special check for multiplication '*' vs wildcard:
        // In SELECT * or table.* or COUNT(*), '*' is NOT a binary operator.
        if (opText === '*') {
          const prevToken = i > 0 ? nonTrivia[i - 1] : null;
          if (
            !prevToken ||
            prevToken.type === 'DOT' ||
            prevToken.type === 'COMMA' ||
            prevToken.type === 'LPAREN' ||
            (prevToken.type === 'KEYWORD' && ['SELECT', 'DISTINCT', 'ALL'].includes(prevToken.text.toUpperCase()))
          ) {
            continue; // wildcard
          }
        }

        // Special check for unary '+' or '-':
        // If preceded by operator, lparen, comma, keyword, it can be unary if next is a number
        if ((opText === '+' || opText === '-') && nextToken && nextToken.type === 'NUMBER') {
          const prevToken = i > 0 ? nonTrivia[i - 1] : null;
          if (
            !prevToken ||
            prevToken.type === 'OPERATOR' ||
            prevToken.type === 'LPAREN' ||
            prevToken.type === 'COMMA' ||
            (prevToken.type === 'KEYWORD' && ['WHERE', 'HAVING', 'ON', 'AND', 'OR'].includes(prevToken.text.toUpperCase()))
          ) {
            continue; // unary number
          }
        }

        // Check if right-hand operand is missing:
        if (
          !nextToken ||
          nextToken.type === 'SEMICOLON' ||
          nextToken.type === 'RPAREN' ||
          nextToken.type === 'COMMA' ||
          (nextToken.type === 'KEYWORD' && CLAUSE_BOUNDARY_KEYWORDS.has(nextToken.text.toUpperCase())) ||
          (nextToken.type === 'OPERATOR' && nextToken.text !== '+' && nextToken.text !== '-') ||
          (nextToken.type === 'KEYWORD' && (nextToken.text.toUpperCase() === 'AND' || nextToken.text.toUpperCase() === 'OR'))
        ) {
          diagnostics.push({
            range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
            message: `Dangling operator '${token.text}' missing operand`,
            severity: vscode.DiagnosticSeverity.Error
          });
        }
      } else if (token.type === 'KEYWORD' && opText === 'NOT') {
        if (
          !nextToken ||
          nextToken.type === 'SEMICOLON' ||
          nextToken.type === 'RPAREN' ||
          nextToken.type === 'COMMA' ||
          (nextToken.type === 'KEYWORD' && (nextToken.text.toUpperCase() === 'AND' || nextToken.text.toUpperCase() === 'OR' || CLAUSE_BOUNDARY_KEYWORDS.has(nextToken.text.toUpperCase())))
        ) {
          diagnostics.push({
            range: this.toDocRange(document, sqlBlock.startOffset, token.start, token.end),
            message: "Dangling operator 'NOT' missing condition",
            severity: vscode.DiagnosticSeverity.Error
          });
        }
      }
    }

    return diagnostics;
  }

  private toDocRange(
    document: vscode.TextDocument,
    blockStartOffset: number,
    localStart: number,
    localEnd: number
  ): vscode.Range {
    const startPos = document.positionAt(blockStartOffset + localStart);
    const endPos = document.positionAt(blockStartOffset + localEnd);
    return new vscode.Range(startPos, endPos);
  }
}
