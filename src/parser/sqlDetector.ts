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
    // Scan quotes around offset
    // Triple quotes take priority
    const tripleQuotePatterns = ['"""', "'''"];
    for (const tq of tripleQuotePatterns) {
      const match = this.matchQuotePair(text, offset, tq);
      if (match) {
        return match;
      }
    }

    // Single quotes
    const singleQuotePatterns = ['"', "'"];
    for (const sq of singleQuotePatterns) {
      const match = this.matchQuotePair(text, offset, sq);
      if (match) {
        return match;
      }
    }

    return null;
  }

  private static matchQuotePair(
    text: string,
    offset: number,
    quote: string
  ): { start: number; end: number; quoteType: string; prefixBeforeQuote: string } | null {
    const qLen = quote.length;

    // Search backwards for opening quote starting before cursor
    let openPos = -1;
    let searchPos = offset - 1;

    while (searchPos >= 0) {
      const idx = text.lastIndexOf(quote, searchPos);
      if (idx === -1) {
        break;
      }

      // Check for escape character `\`
      let backslashCount = 0;
      let p = idx - 1;
      while (p >= 0 && text[p] === '\\') {
        backslashCount++;
        p--;
      }

      if (backslashCount % 2 === 0) {
        // Not escaped
        // Also ensure not part of a longer quote if checking single quote
        if (qLen === 1) {
          const isPartOfTriple =
            (idx >= 2 && text.slice(idx - 2, idx + 1) === quote.repeat(3)) ||
            (idx >= 1 && idx + 1 < text.length && text.slice(idx - 1, idx + 2) === quote.repeat(3)) ||
            (idx + 2 < text.length && text.slice(idx, idx + 3) === quote.repeat(3));
          if (isPartOfTriple) {
            searchPos = idx - 1;
            continue;
          }
        }

        openPos = idx;
        break;
      }
      searchPos = idx - 1;
    }

    if (openPos === -1) {
      return null;
    }

    // Now find matching closing quote after openPos + qLen
    const startOfContent = openPos + qLen;
    if (offset < startOfContent) {
      return null;
    }

    let closePos = -1;
    let cSearchPos = startOfContent;

    while (cSearchPos < text.length) {
      const idx = text.indexOf(quote, cSearchPos);
      if (idx === -1) {
        break;
      }

      let backslashCount = 0;
      let p = idx - 1;
      while (p >= 0 && text[p] === '\\') {
        backslashCount++;
        p--;
      }

      if (backslashCount % 2 === 0) {
        if (qLen === 1) {
          const isPartOfTriple =
            (idx >= 2 && text.slice(idx - 2, idx + 1) === quote.repeat(3)) ||
            (idx >= 1 && idx + 1 < text.length && text.slice(idx - 1, idx + 2) === quote.repeat(3)) ||
            (idx + 2 < text.length && text.slice(idx, idx + 3) === quote.repeat(3));
          if (isPartOfTriple) {
            cSearchPos = idx + 1;
            continue;
          }
        }

        closePos = idx;
        break;
      }
      cSearchPos = idx + 1;
    }

    const end = closePos !== -1 ? closePos : text.length;

    // Check prefix up to 300 characters before openPos
    const searchStart = Math.max(0, openPos - 300);
    const prefixBeforeQuote = text.slice(searchStart, openPos);

    if (offset >= startOfContent && offset <= end) {
      return {
        start: startOfContent,
        end,
        quoteType: quote,
        prefixBeforeQuote
      };
    }

    return null;
  }
}
