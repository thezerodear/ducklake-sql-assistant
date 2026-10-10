import * as vscode from 'vscode';
import { SchemaManager } from '../catalog/schemaManager';
import { SqlDetector } from '../parser/sqlDetector';
import { SqlValidator } from './sqlValidator';
import { SchemaValidator } from './schemaValidator';

export class SqlDiagnosticsManager implements vscode.Disposable {
  private diagnosticCollection: vscode.DiagnosticCollection;
  private schemaManager: SchemaManager;
  private sqlValidator: SqlValidator;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private disposables: vscode.Disposable[] = [];
  private debounceMs = 300;

  constructor(schemaManager: SchemaManager) {
    this.schemaManager = schemaManager;
    this.sqlValidator = new SqlValidator();
    this.diagnosticCollection = vscode.languages.createDiagnosticCollection('ducklake-sql-diagnostics');

    // Subscribe to document lifecycle events
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isSupportedDocument(event.document)) {
          this.triggerValidation(event.document, false);
        }
      }),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (this.isSupportedDocument(document)) {
          this.triggerValidation(document, true);
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.isSupportedDocument(document)) {
          this.triggerValidation(document, true);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.clearDiagnostics(document);
      }),
      this.schemaManager.onDidChangeSchema(() => {
        this.validateAllOpenDocuments();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('ducklake.diagnostics')) {
          this.handleConfigChange();
        }
      })
    );

    // Initial validation across open documents
    this.validateAllOpenDocuments();
  }

  public triggerValidation(document: vscode.TextDocument, immediate: boolean = false): void {
    if (!this.isSupportedDocument(document)) {
      return;
    }

    const uriKey = document.uri.toString();
    const existingTimer = this.debounceTimers.get(uriKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.debounceTimers.delete(uriKey);
    }

    if (immediate) {
      this.validateDocument(document);
    } else {
      const timer = setTimeout(() => {
        this.debounceTimers.delete(uriKey);
        this.validateDocument(document);
      }, this.debounceMs);
      this.debounceTimers.set(uriKey, timer);
    }
  }

  public validateDocument(document: vscode.TextDocument): void {
    const config = vscode.workspace.getConfiguration('ducklake');
    const enabled = config.get<boolean>('diagnostics.enable', true);

    if (!enabled) {
      this.diagnosticCollection.delete(document.uri);
      return;
    }

    const checkSchema = config.get<boolean>('diagnostics.checkSchema', true);
    const blocks = SqlDetector.findAllSqlBlocks(document);

    if (blocks.length === 0) {
      this.diagnosticCollection.set(document.uri, []);
      return;
    }

    const documentDiagnostics: vscode.Diagnostic[] = [];

    for (const block of blocks) {
      // 1. Syntax validation (DiagnosticSeverity.Error)
      const syntaxItems = this.sqlValidator.validateSyntax(document, block);
      for (const item of syntaxItems) {
        const diag = new vscode.Diagnostic(item.range, item.message, item.severity);
        diag.source = 'DuckLake SQL';
        documentDiagnostics.push(diag);
      }

      // 2. Schema validation (DiagnosticSeverity.Warning)
      if (checkSchema) {
        const schemaItems = SchemaValidator.validateSchema(document, block, this.schemaManager);
        for (const item of schemaItems) {
          const diag = new vscode.Diagnostic(item.range, item.message, item.severity);
          diag.source = 'DuckLake SQL';
          documentDiagnostics.push(diag);
        }
      }
    }

    this.diagnosticCollection.set(document.uri, documentDiagnostics);
  }

  public clearDiagnostics(document: vscode.TextDocument): void {
    const uriKey = document.uri.toString();
    const timer = this.debounceTimers.get(uriKey);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(uriKey);
    }
    this.diagnosticCollection.delete(document.uri);
  }

  public validateAllOpenDocuments(): void {
    const docs = vscode.workspace.textDocuments;
    if (docs && docs.length > 0) {
      for (const doc of docs) {
        if (this.isSupportedDocument(doc)) {
          this.triggerValidation(doc, true);
        }
      }
    }
  }

  public handleConfigChange(): void {
    const config = vscode.workspace.getConfiguration('ducklake');
    const enabled = config.get<boolean>('diagnostics.enable', true);

    if (!enabled) {
      this.diagnosticCollection.clear();
      for (const timer of this.debounceTimers.values()) {
        clearTimeout(timer);
      }
      this.debounceTimers.clear();
    } else {
      this.validateAllOpenDocuments();
    }
  }

  public getDiagnosticCollection(): vscode.DiagnosticCollection {
    return this.diagnosticCollection;
  }

  public dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }

  private isSupportedDocument(document: vscode.TextDocument): boolean {
    if (!document || !document.uri) {
      return false;
    }
    // Support Python files (.py) and Jupyter notebook cells (vscode-notebook-cell)
    if (document.languageId === 'python') {
      return true;
    }
    if (document.uri.scheme === 'vscode-notebook-cell') {
      return document.languageId === 'python';
    }
    if (document.fileName && document.fileName.endsWith('.py')) {
      return true;
    }
    return false;
  }
}
