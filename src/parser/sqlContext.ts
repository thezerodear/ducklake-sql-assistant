export enum SqlContextType {
  TABLE = 'TABLE',
  COLUMN = 'COLUMN',
  DOT_COLUMN = 'DOT_COLUMN',
  GENERAL = 'GENERAL'
}

export interface SqlQueryAnalysis {
  contextType: SqlContextType;
  dotQualifier?: string;          // e.g. "u" in "u.name"
  dotPrefix?: string;             // e.g. "us" in "u.us"
  referencedTables: string[];     // tables mentioned in FROM / JOIN
  aliasMap: Map<string, string>;  // alias -> table name (e.g. "u" -> "lake_users")
  currentToken: string;
}

export class SqlContextAnalyzer {
  private static readonly TABLE_KEYWORDS = [
    'FROM', 'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN',
    'CROSS JOIN', 'INTO', 'UPDATE', 'TABLE', 'COPY'
  ];

  public static analyze(sqlPrefix: string, fullSql: string): SqlQueryAnalysis {
    const { referencedTables, aliasMap } = this.extractTablesAndAliases(fullSql);
    const trimmedPrefix = sqlPrefix.trimEnd();

    // 1. Check for Dot notation completion: "u." or "u.use" or "lake_users.em" or "ลูกค้า."
    const dotMatch = trimmedPrefix.match(/([a-zA-Z0-9_"\u0E00-\u0E7F]+)\.([a-zA-Z0-9_"\u0E00-\u0E7F]*)$/);
    if (dotMatch) {
      const rawQualifier = dotMatch[1].replace(/["`]/g, '');
      const dotPrefix = dotMatch[2]?.replace(/["`]/g, '') || '';
      const resolvedTable = aliasMap.get(rawQualifier.toLowerCase()) || rawQualifier;
      return {
        contextType: SqlContextType.DOT_COLUMN,
        dotQualifier: resolvedTable,
        dotPrefix,
        referencedTables,
        aliasMap,
        currentToken: dotPrefix
      };
    }

    // 2. Extract current word token
    const lastWordMatch = trimmedPrefix.match(/([a-zA-Z0-9_"\u0E00-\u0E7F]+)$/);
    const currentToken = lastWordMatch ? lastWordMatch[1].replace(/["`]/g, '') : '';

    const prefixWithoutCurrentToken = trimmedPrefix.slice(0, trimmedPrefix.length - (lastWordMatch ? lastWordMatch[1].length : 0)).trimEnd();
    const upperPrefix = prefixWithoutCurrentToken.toUpperCase();

    // 3. Check for TABLE context (after FROM, JOIN, INTO, TABLE, etc.)
    for (const kw of this.TABLE_KEYWORDS) {
      if (upperPrefix.endsWith(kw)) {
        return {
          contextType: SqlContextType.TABLE,
          referencedTables,
          aliasMap,
          currentToken
        };
      }
    }

    // 4. Check for COLUMN context:
    // a) After SELECT, WHERE, ON, GROUP BY, ORDER BY, HAVING, AND, OR, or comma
    if (/(?:SELECT|WHERE|ON|GROUP\s+BY|ORDER\s+BY|HAVING|AND|OR|,)\s*$/i.test(prefixWithoutCurrentToken) ||
        /(?:SELECT|WHERE|ON|GROUP\s+BY|ORDER\s+BY|HAVING|AND|OR|,)\s+[a-zA-Z0-9_"\u0E00-\u0E7F]*$/i.test(trimmedPrefix)) {
      return {
        contextType: SqlContextType.COLUMN,
        referencedTables,
        aliasMap,
        currentToken
      };
    }

    // b) Check if cursor is between SELECT and FROM
    const selectIdx = fullSql.toUpperCase().indexOf('SELECT');
    const fromIdx = fullSql.toUpperCase().indexOf('FROM');
    const cursorIdx = sqlPrefix.length;
    if (selectIdx !== -1 && fromIdx !== -1 && cursorIdx > selectIdx && cursorIdx < fromIdx) {
      return {
        contextType: SqlContextType.COLUMN,
        referencedTables,
        aliasMap,
        currentToken
      };
    }

    return {
      contextType: SqlContextType.GENERAL,
      referencedTables,
      aliasMap,
      currentToken
    };
  }

  /**
   * Extracts tables and aliases from SQL query
   */
  private static extractTablesAndAliases(sql: string): { referencedTables: string[]; aliasMap: Map<string, string> } {
    const referencedTables: string[] = [];
    const aliasMap = new Map<string, string>();

    const identPattern = '(?:"[^"]+"|`[^`]+`|[\\w\\u0E00-\\u0E7F]+)';
    const tablePattern = '(?:' + identPattern + '(?:\\.' + identPattern + ')*)';
    const reservedKeywords = 'WHERE|ON|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|GROUP|ORDER|LIMIT|USING|SET|VALUES|SELECT|UNION';
    const aliasPattern = '(?:AS\\s+(' + identPattern + ')|(?!' + reservedKeywords + '\\b)(' + identPattern + '))';

    const fromJoinRegex = new RegExp('(?:\\bFROM|\\bJOIN)\\s+(' + tablePattern + ')(?:\\s+' + aliasPattern + ')?', 'gi');
    let match: RegExpExecArray | null;

    while ((match = fromJoinRegex.exec(sql)) !== null) {
      const rawTable = match[1].replace(/["`]/g, '').toLowerCase();
      const parts = rawTable.split('.');
      const simpleTable = parts[parts.length - 1];

      referencedTables.push(simpleTable);
      aliasMap.set(simpleTable, simpleTable);
      if (rawTable !== simpleTable) {
        referencedTables.push(rawTable);
        aliasMap.set(rawTable, simpleTable);
        if (parts.length >= 2) {
          const twoPart = parts.slice(-2).join('.');
          aliasMap.set(twoPart, simpleTable);
        }
      }

      const alias = (match[2] || match[3] || '').replace(/["`]/g, '');
      if (alias) {
        const lowerAlias = alias.toLowerCase();
        const reserved = ['on', 'where', 'left', 'right', 'inner', 'full', 'cross', 'join', 'group', 'order', 'limit', 'using'];
        if (!reserved.includes(lowerAlias)) {
          aliasMap.set(lowerAlias, simpleTable);
        }
      }
    }

    return { referencedTables, aliasMap };
  }
}
