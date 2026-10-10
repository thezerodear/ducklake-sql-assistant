// test/e2e/harness/vscodeShim.js
// Headless VS Code mock shim for running SchemaManager and extension components outside VS Code.

const Module = require('module');
const path = require('path');

class Disposable {
  constructor(disposeFn) {
    this._disposeFn = disposeFn;
  }
  dispose() {
    if (typeof this._disposeFn === 'function') {
      this._disposeFn();
    }
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
  }
  get event() {
    return (listener) => {
      this.listeners.push(listener);
      return new Disposable(() => {
        const idx = this.listeners.indexOf(listener);
        if (idx !== -1) this.listeners.splice(idx, 1);
      });
    };
  }
  fire(data) {
    for (const listener of [...this.listeners]) {
      try {
        listener(data);
      } catch (err) {
        console.error('EventEmitter error:', err);
      }
    }
  }
  dispose() {
    this.listeners = [];
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

const defaultConfig = {
  'postgres.connectionString': '',
  'postgres.host': '127.0.0.1',
  'postgres.port': 54332,
  'postgres.database': 'ducklake_e2e',
  'postgres.user': 'postgres',
  'postgres.password': '',
  'postgres.ssl': false,
  'postgres.clientEncoding': 'auto',
  'catalogSchemas': ['public', 'main'],
  'autoRefreshMinutes': 0, // 0 disables auto-refresh in test
  'enableSmartHeuristic': true,
  'suggestDuckDBFunctions': true,
  'duckdb.databasePath': '',
  'alwaysEnableInTripleQuotes': true,
  'connectionName': 'lake',
  'catalogType': 'server',
  'dataStorage': 'local',
  'dataPath': '',
  'overrideDataPath': false,
  'databaseAlias': 'lake',
  'ducklake.diagnostics.enable': true,
  'ducklake.diagnostics.checkSchema': true,
  'diagnostics.enable': true,
  'diagnostics.checkSchema': true
};

let currentConfig = { ...defaultConfig };

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startOrStartLine, endOrStartChar, endLine, endChar) {
    if (typeof startOrStartLine === 'number') {
      this.start = new Position(startOrStartLine, endOrStartChar);
      this.end = new Position(endLine, endChar);
    } else {
      this.start = startOrStartLine;
      this.end = endOrStartChar;
    }
  }
}

class Selection extends Range {
  constructor(anchor, active) {
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }
}

class SnippetString {
  constructor(value = '') {
    this.value = value;
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value;
  }
  appendMarkdown(str) {
    this.value += str;
    return this;
  }
}

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}

const CompletionItemKind = {
  Text: 1,
  Method: 2,
  Function: 3,
  Constructor: 4,
  Field: 5,
  Variable: 6,
  Class: 7,
  Interface: 8,
  Module: 9,
  Property: 10,
  Unit: 11,
  Value: 12,
  Enum: 13,
  Keyword: 14,
  Snippet: 15,
  Color: 16,
  File: 17,
  Reference: 18,
  Folder: 19,
  EnumMember: 20,
  Constant: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25
};

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2
};

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3
};

class Diagnostic {
  constructor(range, message, severity = DiagnosticSeverity.Error) {
    this.range = range;
    this.message = message;
    this.severity = severity;
    this.source = 'DuckLake SQL';
    this.code = undefined;
    this.relatedInformation = [];
    this.tags = [];
  }
}

class DiagnosticCollection {
  constructor(name = '') {
    this.name = name;
    this._diagnostics = new Map();
    this.isDisposed = false;
  }

  set(uriOrEntries, diagnostics) {
    if (this.isDisposed) return;
    if (Array.isArray(uriOrEntries)) {
      for (const [uri, diags] of uriOrEntries) {
        this.set(uri, diags);
      }
      return;
    }
    const uriKey = uriOrEntries ? (typeof uriOrEntries === 'string' ? uriOrEntries : (uriOrEntries.toString ? uriOrEntries.toString() : String(uriOrEntries))) : '';
    if (!diagnostics || diagnostics.length === 0) {
      this._diagnostics.delete(uriKey);
    } else {
      this._diagnostics.set(uriKey, [...diagnostics]);
    }
  }

  delete(uri) {
    if (this.isDisposed) return;
    const uriKey = uri ? (typeof uri === 'string' ? uri : (uri.toString ? uri.toString() : String(uri))) : '';
    this._diagnostics.delete(uriKey);
  }

  clear() {
    if (this.isDisposed) return;
    this._diagnostics.clear();
  }

  get(uri) {
    const uriKey = uri ? (typeof uri === 'string' ? uri : (uri.toString ? uri.toString() : String(uri))) : '';
    return this._diagnostics.get(uriKey) || [];
  }

  has(uri) {
    const uriKey = uri ? (typeof uri === 'string' ? uri : (uri.toString ? uri.toString() : String(uri))) : '';
    const diags = this._diagnostics.get(uriKey);
    return !!(diags && diags.length > 0);
  }

  forEach(callback, thisArg) {
    for (const [uriStr, diags] of this._diagnostics.entries()) {
      callback.call(thisArg, mockVscode.Uri.parse(uriStr), diags, this);
    }
  }

  dispose() {
    this.clear();
    this.isDisposed = true;
    if (mockVscode.languages._diagnosticCollections) {
      mockVscode.languages._diagnosticCollections.delete(this.name);
    }
  }
}

const onDidChangeTextDocumentEmitter = new EventEmitter();
const onDidOpenTextDocumentEmitter = new EventEmitter();
const onDidSaveTextDocumentEmitter = new EventEmitter();
const onDidCloseTextDocumentEmitter = new EventEmitter();
const onDidChangeConfigurationEmitter = new EventEmitter();

const diagnosticCollections = new Map();

const mockVscode = {
  Disposable,
  EventEmitter,
  RelativePattern,
  Position,
  Range,
  Selection,
  SnippetString,
  MarkdownString,
  CompletionItem,
  CompletionItemKind,
  TreeItem,
  TreeItemCollapsibleState,
  ThemeIcon,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticCollection,
  Uri: {
    file: (fsPath) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` }),
    parse: (uriStr) => {
      const match = uriStr.match(/^([a-zA-Z0-9+.-]+):(?:\/\/)?(.*)$/);
      const scheme = match ? match[1] : 'file';
      const pathPart = match ? match[2] : uriStr;
      return {
        fsPath: pathPart,
        scheme,
        toString: () => uriStr
      };
    }
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key, defaultValue) => {
        const fullKey = section ? `${section}.${key}` : key;
        if (currentConfig.hasOwnProperty(fullKey)) {
          return currentConfig[fullKey];
        }
        if (currentConfig.hasOwnProperty(key)) {
          return currentConfig[key];
        }
        return defaultValue;
      },
      update: async (key, value) => {
        const fullKey = section ? `${section}.${key}` : key;
        currentConfig[fullKey] = value;
      }
    }),
    createFileSystemWatcher: () => ({
      onDidChange: () => new Disposable(() => {}),
      onDidCreate: () => new Disposable(() => {}),
      onDidDelete: () => new Disposable(() => {}),
      dispose: () => {}
    }),
    textDocuments: [],
    onDidChangeTextDocument: onDidChangeTextDocumentEmitter.event,
    onDidOpenTextDocument: onDidOpenTextDocumentEmitter.event,
    onDidSaveTextDocument: onDidSaveTextDocumentEmitter.event,
    onDidCloseTextDocument: onDidCloseTextDocumentEmitter.event,
    onDidChangeConfiguration: onDidChangeConfigurationEmitter.event,
    _emitDidChangeTextDocument: (e) => onDidChangeTextDocumentEmitter.fire(e),
    _emitOnDidOpenTextDocument: (doc) => {
      if (doc && !mockVscode.workspace.textDocuments.includes(doc)) {
        mockVscode.workspace.textDocuments.push(doc);
      }
      onDidOpenTextDocumentEmitter.fire(doc);
    },
    _emitOnDidSaveTextDocument: (doc) => onDidSaveTextDocumentEmitter.fire(doc),
    _emitOnDidCloseTextDocument: (doc) => {
      if (doc) {
        const idx = mockVscode.workspace.textDocuments.indexOf(doc);
        if (idx !== -1) mockVscode.workspace.textDocuments.splice(idx, 1);
      }
      onDidCloseTextDocumentEmitter.fire(doc);
    },
    _emitDidChangeConfiguration: (e) => onDidChangeConfigurationEmitter.fire(e)
  },
  window: {
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined
  },
  env: {
    clipboard: {
      _content: '',
      writeText: async (text) => {
        mockVscode.env.clipboard._content = text;
      },
      readText: async () => mockVscode.env.clipboard._content
    }
  },
  commands: {
    registerCommand: (cmd, callback) => new Disposable(() => {}),
    executeCommand: async (cmd, ...args) => undefined
  },
  languages: {
    _diagnosticCollections: diagnosticCollections,
    createDiagnosticCollection: (name = 'default') => {
      const col = new DiagnosticCollection(name);
      diagnosticCollections.set(name, col);
      return col;
    },
    getDiagnostics: (resource) => {
      if (resource) {
        const uriKey = resource.toString ? resource.toString() : String(resource);
        const list = [];
        for (const col of diagnosticCollections.values()) {
          const d = col.get(resource);
          if (d && d.length) list.push(...d);
        }
        return list;
      }
      const all = [];
      for (const col of diagnosticCollections.values()) {
        for (const [uriKey, diags] of col._diagnostics.entries()) {
          all.push([mockVscode.Uri.parse(uriKey), diags]);
        }
      }
      return all;
    },
    registerCompletionItemProvider: () => new Disposable(() => {}),
    registerHoverProvider: () => new Disposable(() => {})
  }
};

let installed = false;
let origResolve = null;

function installShim() {
  if (installed) return;
  origResolve = Module._resolveFilename;
  const virtualVscodePath = path.resolve(__dirname, '__virtual_vscode__.js');

  Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') {
      return virtualVscodePath;
    }
    return origResolve.call(this, request, parent, isMain, options);
  };

  require.cache[virtualVscodePath] = {
    id: virtualVscodePath,
    filename: virtualVscodePath,
    loaded: true,
    exports: mockVscode
  };

  installed = true;
}

function setMockConfig(keyOrObject, value) {
  const changedKeys = [];
  if (typeof keyOrObject === 'object') {
    Object.assign(currentConfig, keyOrObject);
    changedKeys.push(...Object.keys(keyOrObject));
  } else {
    currentConfig[keyOrObject] = value;
    changedKeys.push(keyOrObject);
  }
  onDidChangeConfigurationEmitter.fire({
    affectsConfiguration: (sec) => changedKeys.some(k => k === sec || k.startsWith(sec + '.'))
  });
}

function resetMockConfig() {
  currentConfig = { ...defaultConfig };
}

function resetDiagnosticCollections() {
  for (const col of diagnosticCollections.values()) {
    col.clear();
  }
  diagnosticCollections.clear();
}

// Auto-install when required
installShim();

module.exports = {
  mockVscode,
  installShim,
  setMockConfig,
  resetMockConfig,
  resetDiagnosticCollections,
  Disposable,
  EventEmitter,
  RelativePattern,
  Position,
  Range,
  Selection,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticCollection
};
