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

const mockVscode = {
  Disposable,
  EventEmitter,
  RelativePattern,
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
    registerCommand: (cmd, callback) => new Disposable(() => {})
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
