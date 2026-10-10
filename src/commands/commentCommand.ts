import * as vscode from 'vscode';
import { SqlDetector } from '../parser/sqlDetector';

/**
 * Checks if a specific position in the document is inside a detected SQL block
 */
export function isPositionInsideSql(document: vscode.TextDocument, position: vscode.Position, enableSmartHeuristic: boolean = true): boolean {
  const detection = SqlDetector.detect(document, position, enableSmartHeuristic);
  return Boolean(detection && detection.isSql);
}

/**
 * Checks if a specific line index is strictly within the detected SQL content boundaries
 */
export function isLineInsideSqlRange(document: vscode.TextDocument, lineIndex: number, sqlStartOffset: number, sqlEndOffset: number): boolean {
  if (!document || lineIndex < 0 || lineIndex >= document.lineCount) {
    return false;
  }
  const line = document.lineAt(lineIndex);
  const lineStartOffset = document.offsetAt(line.range.start);
  const lineEndOffset = document.offsetAt(line.range.end);
  return lineStartOffset >= sqlStartOffset && lineEndOffset <= sqlEndOffset;
}

/**
 * Checks if a line text is commented with SQL comment prefix `--`
 */
export function isSqlCommented(lineText: string): boolean {
  return /^\s*--/.test(lineText);
}

/**
 * Toggles SQL comment on a line text:
 * - If line starts with `--` (after leading whitespace), removes `-- ` or `--`
 * - If line does not start with `--`, inserts `-- ` after leading whitespace
 */
export function toggleSqlLineComment(lineText: string, uncomment: boolean): string {
  if (uncomment) {
    return lineText.replace(/^(\s*)--\s?/, '$1');
  } else {
    if (lineText.trim().length === 0) {
      return lineText + '-- ';
    }
    return lineText.replace(/^(\s*)(.*)$/, '$1-- $2');
  }
}

/**
 * Context-aware toggle comment command for Python and Jupyter Notebook SQL blocks:
 * - Inside SQL blocks: toggles `-- ` line comments
 * - Outside SQL blocks: delegates to VS Code's built-in `editor.action.commentLine` (#)
 */
export async function toggleCommentCommand(editor?: vscode.TextEditor): Promise<boolean> {
  if (!editor) {
    editor = vscode.window.activeTextEditor;
  }
  if (!editor || !editor.document || !editor.selection) {
    return false;
  }

  const document = editor.document;
  const config = vscode.workspace.getConfiguration('ducklake');
  const enableSmartHeuristic = config.get<boolean>('enableSmartHeuristic', true);

  const primarySelection = editor.selection;
  const cursorPosition = primarySelection.active || primarySelection.start;
  if (!cursorPosition) {
    return false;
  }

  const sqlDetection = SqlDetector.detect(document, cursorPosition, enableSmartHeuristic);

  if (!sqlDetection || !sqlDetection.isSql) {
    // Outside SQL string: delegate seamlessly to VS Code default Python commenting (#)
    if (vscode.commands && typeof vscode.commands.executeCommand === 'function') {
      try {
        await vscode.commands.executeCommand('editor.action.commentLine');
      } catch {
        // Ignore delegation errors cleanly
      }
    }
    return false;
  }

  // Collect all lines covered by active selections
  const lineSet = new Set<number>();
  const activeSelections = (editor.selections && editor.selections.length > 0)
    ? editor.selections
    : [primarySelection];

  for (const sel of activeSelections) {
    let sLine = sel.start.line;
    let eLine = sel.end.line;
    if (eLine > sLine && sel.end.character === 0) {
      eLine--;
    }
    for (let i = sLine; i <= eLine; i++) {
      lineSet.add(i);
    }
  }

  const lineIndices = Array.from(lineSet).sort((a, b) => a - b);
  if (lineIndices.length === 0) {
    lineIndices.push(cursorPosition.line);
  }

  // Ensure selected lines are within SQL boundaries and not Python quote delimiters
  const allLinesInSql = lineIndices.every(idx =>
    isLineInsideSqlRange(document, idx, sqlDetection.startOffset, sqlDetection.endOffset)
  );

  if (!allLinesInSql) {
    if (vscode.commands && typeof vscode.commands.executeCommand === 'function') {
      try {
        await vscode.commands.executeCommand('editor.action.commentLine');
      } catch {
        // Ignore delegation errors cleanly
      }
    }
    return false;
  }

  const nonEmptyLines = lineIndices
    .map(idx => document.lineAt(idx).text)
    .filter(text => text.trim().length > 0);

  const allCommented = nonEmptyLines.length > 0 && nonEmptyLines.every(text => isSqlCommented(text));
  const shouldUncomment = allCommented;

  const success = await editor.edit(editBuilder => {
    for (const lineIdx of lineIndices) {
      const line = document.lineAt(lineIdx);
      const originalText = line.text;

      if (shouldUncomment) {
        if (isSqlCommented(originalText)) {
          const newText = toggleSqlLineComment(originalText, true);
          editBuilder.replace(line.range, newText);
        }
      } else {
        if (!isSqlCommented(originalText)) {
          if (originalText.trim().length > 0 || lineIndices.length === 1) {
            const newText = toggleSqlLineComment(originalText, false);
            editBuilder.replace(line.range, newText);
          }
        }
      }
    }
  });

  return Boolean(success);
}
