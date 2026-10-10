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
  'databaseAlias': 'lake'
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
  Uri: {
    file: (fsPath) => ({ fsPath, scheme: 'file', toString: () => `file://${fsPath}` }),
    parse: (uriStr) => ({ fsPath: uriStr.replace(/^file:\/\//, ''), scheme: 'file', toString: () => uriStr })
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
    })
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
  if (typeof keyOrObject === 'object') {
    Object.assign(currentConfig, keyOrObject);
  } else {
    currentConfig[keyOrObject] = value;
  }
}

function resetMockConfig() {
  currentConfig = { ...defaultConfig };
}

// Auto-install when required
installShim();

module.exports = {
  mockVscode,
  installShim,
  setMockConfig,
  resetMockConfig,
  Disposable,
  EventEmitter,
  RelativePattern
};
