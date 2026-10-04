import * as vscode from 'vscode';
import { SchemaManager } from '../catalog/schemaManager';
import { SqlDetector } from '../parser/sqlDetector';
import { SqlContextAnalyzer } from '../parser/sqlContext';

export class DuckLakeHoverProvider implements vscode.HoverProvider {
  private schemaManager: SchemaManager;

  constructor(schemaManager: SchemaManager) {
    this.schemaManager = schemaManager;
  }

  public provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Hover> {
    const config = this.schemaManager.readConfig();
    const sqlDetection = SqlDetector.detect(document, position, config.enableSmartHeuristic);
    if (!sqlDetection || !sqlDetection.isSql) {
      return undefined;
    }

    const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z0-9_.]+/);
    if (!wordRange) {
      return undefined;
    }

    const word = document.getText(wordRange);

    // 1. Check if hovering over "table.column" or "alias.column"
    if (word.includes('.')) {
      const parts = word.split('.');
      const qualifier = parts[0];
      const colName = parts[1];

      const { aliasMap } = SqlContextAnalyzer.analyze(sqlDetection.sqlPrefix, sqlDetection.fullSql);
      const tableName = aliasMap.get(qualifier.toLowerCase()) || qualifier;
      const table = this.schemaManager.findTable(tableName);

      if (table) {
        const col = table.columns.find(c => c.name.toLowerCase() === colName.toLowerCase());
        if (col) {
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`### \`${table.name}.${col.name}\`\n\n`);
          md.appendMarkdown(`- **Type:** \`${col.dataType}\`\n`);
          md.appendMarkdown(`- **Table:** \`${table.fullName}\`\n`);
          md.appendMarkdown(`- **Nullable:** ${col.isNullable ? 'YES' : 'NO'}\n`);
          if (col.defaultValue) {
            md.appendMarkdown(`- **Default:** \`${col.defaultValue}\`\n`);
          }
          if (col.comment) {
            md.appendMarkdown(`- **Comment:** ${col.comment}\n`);
          }
          return new vscode.Hover(md, wordRange);
        }
      }
    }

    // 2. Check if hovering over a Table Name
    const table = this.schemaManager.findTable(word);
    if (table) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`### 🦆 DuckLake Table: \`${table.fullName}\`\n\n`);
      md.appendMarkdown(`**Type:** ${table.type}  \n`);
      if (table.comment) {
        md.appendMarkdown(`**Description:** ${table.comment}  \n\n`);
      }

      md.appendMarkdown(`| Column | Type | Nullable |\n| :--- | :--- | :--- |\n`);
      for (const col of table.columns) {
        md.appendMarkdown(`| \`${col.name}\` | \`${col.dataType}\` | ${col.isNullable ? 'YES' : 'NO'} |\n`);
      }
      return new vscode.Hover(md, wordRange);
    }

    // 3. Check if hovering over a Column Name directly
    const { referencedTables } = SqlContextAnalyzer.analyze(sqlDetection.sqlPrefix, sqlDetection.fullSql);
    for (const tblName of referencedTables) {
      const tbl = this.schemaManager.findTable(tblName);
      if (tbl) {
        const col = tbl.columns.find(c => c.name.toLowerCase() === word.toLowerCase());
        if (col) {
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`### Column \`${word}\` (\`${tbl.name}\`)\n\n`);
          md.appendMarkdown(`- **Type:** \`${col.dataType}\`\n`);
          md.appendMarkdown(`- **Nullable:** ${col.isNullable ? 'YES' : 'NO'}\n`);
          if (col.defaultValue) {
            md.appendMarkdown(`- **Default:** \`${col.defaultValue}\`\n`);
          }
          if (col.comment) {
            md.appendMarkdown(`- **Description:** ${col.comment}\n`);
          }
          return new vscode.Hover(md, wordRange);
        }
      }
    }

    return undefined;
  }
}
