import * as vscode from 'vscode';

export interface SqlStringContext {
  isSql: boolean;
  sqlPrefix: string;      // SQL text from start of string up to cursor
  fullSql: string;        // Full SQL string inside quote
  quoteType: string;      // '"""' | "'''" | '"' | "'"
  startOffset: number;
  endOffset: number;
}

export class SqlDetector {
  private static readonly SQL_VERBS_REGEX =
    /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*(?:SELECT|WITH|INSERT|CREATE|UPDATE|DELETE|DROP|ALTER|DESCRIBE|EXPLAIN|SHOW|ATTACH|DETACH|PRAGMA|COPY|USE|TRUNCATE)\b/i;

  private static readonly SQL_COMMENT_REGEX =
    /^\s*(?:--\s*sql|\/\*\s*sql\s*\*\/)/i;

  /**
   * Detects if the given position is inside a SQL string literal in Python/Jupyter Notebook
   */
  public static detect(document: vscode.TextDocument, position: vscode.Position, enableSmartHeuristic: boolean = true): SqlStringContext | null {
    const text = document.getText();
    const cursorOffset = document.offsetAt(position);

    // Find if the cursor is within a triple quote or single quote string
    const stringRange = this.findEnclosingString(text, cursorOffset);
    if (!stringRange) {
      return null;
    }

    const { start, end, quoteType, prefixBeforeQuote } = stringRange;
    const content = text.slice(start, end);
    const contentUpToCursor = text.slice(start, cursorOffset);

    // Check if this string qualifies as SQL based on smart heuristics
    const isSql = this.isSqlContent(content, prefixBeforeQuote, enableSmartHeuristic, quoteType);
    if (!isSql) {
      return null;
    }

    return {
      isSql: true,
      sqlPrefix: contentUpToCursor,
      fullSql: content,
      quoteType,
      startOffset: start,
      endOffset: end
    };
  }

  private static isSqlContent(content: string, prefixBeforeQuote: string, enableSmartHeuristic: boolean, quoteType: string): boolean {
    if (!enableSmartHeuristic) {
      return true;
    }

    const trimmedPrefix = prefixBeforeQuote.trimEnd();

    // 1. Explicit comment --sql or /*sql*/
    if (this.SQL_COMMENT_REGEX.test(content)) {
      return true;
    }

    // 2. Preceded by database call: con.sql("""...""") or duckdb.query("""...""")
    if (/(?:con|conn|db|duckdb|session|cursor|engine|spark)\s*\.\s*(?:sql|query|execute|read_sql|write_sql)\s*\(\s*(?:f?r?|r?f?)$/i.test(trimmedPrefix)) {
      return true;
    }

    // 3. Preceded by query variable assignment: query = """...""" or sql = """..."""
    if (/(?:sql|query|stmt|command)\s*=\s*(?:f?r?|r?f?)$/i.test(trimmedPrefix)) {
      return true;
    }

    // 4. Starts with common SQL verbs
    if (this.SQL_VERBS_REGEX.test(content)) {
      return true;
    }

    // 5. Any multiline triple quote containing SQL keywords
    if (quoteType.length === 3) {
      if (/\b(?:SELECT|WITH|FROM|WHERE|INSERT|CREATE|UPDATE|DELETE|ATTACH|PRAGMA|DESCRIBE|SHOW|JOIN)\b/i.test(content)) {
        return true;
      }
    }

    // 6. Contains SELECT ... FROM
    if (/\bSELECT\b[\s\S]+\bFROM\b/i.test(content)) {
      return true;
    }

    return false;
  }

  private static findEnclosingString(
    text: string,
    offset: number
  ): { start: number; end: number; quoteType: string; prefixBeforeQuote: string } | null {
    if (offset < 0 || offset > text.length) {
      return null;
    }

    const n = text.length;
    let pos = 0;

    while (pos < n) {
      const ch = text[pos];

      // Skip Python comments (# ...)
      if (ch === '#') {
        pos++;
        while (pos < n && text[pos] !== '\n') {
          pos++;
        }
        if (pos < n && text[pos] === '\n') {
          pos++;
        }
        continue;
      }

      // Check for triple quotes (""" or ''')
      if (
        (ch === '"' || ch === "'") &&
        pos + 2 < n &&
        text[pos + 1] === ch &&
        text[pos + 2] === ch
      ) {
        const quote = text.slice(pos, pos + 3);
        const openPos = pos;
        pos += 3;
        const contentStart = pos;
        let closePos = -1;

        while (pos < n) {
          if (text[pos] === '\\') {
            if (pos + 2 < n && text[pos + 1] === '\r' && text[pos + 2] === '\n') {
              pos += 3;
            } else {
              pos += 2;
            }
            continue;
          }
          if (
            text[pos] === ch &&
            pos + 2 < n &&
            text[pos + 1] === ch &&
            text[pos + 2] === ch
          ) {
            closePos = pos;
            pos += 3;
            break;
          }
          pos++;
        }

        const contentEnd = closePos !== -1 ? closePos : n;

        if (offset >= contentStart && offset <= contentEnd) {
          const searchStart = Math.max(0, openPos - 300);
          const prefixBeforeQuote = text.slice(searchStart, openPos);
          return {
            start: contentStart,
            end: contentEnd,
            quoteType: quote,
            prefixBeforeQuote
          };
        }

        if (openPos > offset) {
          return null;
        }

        continue;
      }

      // Check for single quotes (" or ')
      if (ch === '"' || ch === "'") {
        const quote = ch;
        const openPos = pos;
        pos++;
        const contentStart = pos;
        let closePos = -1;

        while (pos < n) {
          if (text[pos] === '\\') {
            if (pos + 2 < n && text[pos + 1] === '\r' && text[pos + 2] === '\n') {
              pos += 3;
            } else {
              pos += 2;
            }
            continue;
          }
          if (text[pos] === quote) {
            closePos = pos;
            pos++;
            break;
          }
          if (text[pos] === '\n') {
            closePos = pos;
            break;
          }
          pos++;
        }

        const contentEnd = closePos !== -1 ? closePos : n;

        if (offset >= contentStart && offset <= contentEnd) {
          const searchStart = Math.max(0, openPos - 300);
          const prefixBeforeQuote = text.slice(searchStart, openPos);
          return {
            start: contentStart,
            end: contentEnd,
            quoteType: quote,
            prefixBeforeQuote
          };
        }

        if (openPos > offset) {
          return null;
        }

        continue;
      }

      pos++;
    }

    return null;
  }
}
