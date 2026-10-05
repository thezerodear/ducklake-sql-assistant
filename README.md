# 🦆 DuckLake SQL Assistant for VS Code & Jupyter Notebook

A high-performance VS Code extension designed specifically for **DuckLake / DuckDB over PostgreSQL Catalog**. It provides embedded SQL syntax highlighting, intelligent table/column autocompletion, and schema inspection inside Python string literals and Jupyter Notebook cells.

---

## ✨ Features

- **🎨 Embedded SQL Syntax Highlighting**:
  - Highlights SQL code inside Python triple quotes (`"""..."""` or `'''...'''`) and single quotes.
  - Automatically enabled for:
    - Methods: `con.sql("""...""")`, `duckdb.query(...)`, `cursor.execute(...)`, etc.
    - Magic comments: `"""--sql ..."""` or `"""/*sql*/ ..."""`.
    - Smart Heuristic: Any triple quote starting with SQL verbs (`SELECT`, `WITH`, `INSERT`, `CREATE`, etc.).
  - **Full Jupyter Notebook Support**: Works seamlessly inside `.ipynb` code cells (`vscode-notebook-cell`) as well as `.py` files.

- **⚡ Schema-Aware Autocomplete & Suggestions**:
  - **Tables & Views**: Suggests tables from your PostgreSQL DuckLake catalog when typing after `FROM`, `JOIN`, `INTO`, etc.
  - **Columns & Data Types**:
    - Dot completion: Typing `u.` or `lake_users.` suggests only columns belonging to that table or alias!
    - General column completion: Suggests columns from tables referenced in your query.
  - **DuckDB Lakehouse Functions**: Snippets and completions for `read_parquet(...)`, `read_csv(...)`, `date_trunc(...)`, `list_transform(...)`, `quantile_cont(...)`, etc.

- **🔍 Rich Hover Documentation**:
  - Hover over any table to view its full schema, column types, and descriptions in a formatted Markdown table.
  - Hover over any column to see its data type, nullability, default value, and parent table.

- **🔌 Direct PostgreSQL Catalog Integration**:
  - Connects directly to the PostgreSQL database hosting the DuckLake catalog via `pg`.
  - **No File Locking Issues**: Prevents concurrency locks or DuckDB catalog conflicts.
  - **Secure Extension Storage**: Connection profiles and credentials are stored securely in `connections.json` (`globalStorage`), preventing accidental commits to git repositories while keeping connections available across all workspaces and notebooks.
  - Auto-refresh background timer with real-time status indicator in the VS Code status bar.

---

## 🛠️ Quick Start & Installation

### 1. Build the Extension

Open a terminal in this directory:
```bash
cd ducklake-sql-extension
npm install
npm run compile
```

### 2. Test in VS Code (Development Mode)

1. Open this folder in VS Code (`File > Open Folder...`).
2. Press `F5` (or click `Run > Start Debugging`).
3. An **Extension Development Host** VS Code window will open with the extension loaded.
4. Open [examples/demo_notebook.ipynb](examples/demo_notebook.ipynb) or [examples/demo_python_script.py](examples/demo_python_script.py) to test autocompletion and highlighting immediately!

### 3. Package as `.vsix` (To install permanently in your VS Code)

```bash
npx @vscode/vsce package
```
Then in VS Code:
1. Open the Extensions sidebar (`Ctrl+Shift+X`).
2. Click `...` (Views and More Actions) at the top right.
3. Select **Install from VSIX...** and pick the generated `.vsix` file.

---

## ⚙️ Configuration & Connection Management

DuckLake SQL Assistant stores active database credentials inside `connections.json` under your VS Code User `globalStorage` folder:
- **GUI Modal**: Click the **Plug** icon in the sidebar or run `DuckLake: Connect Catalog (GUI)` to configure connections with a modern user interface.
- **Direct File Editing**: Run `DuckLake: Open Configuration File (connections.json)` or click `connections.json` from the status bar menu.
- **Git Safe**: Since connection configs are stored in the extension's user storage rather than workspace `.vscode/settings.json`, passwords and lakehouse paths will never be accidentally committed to source control!

### Workspace Settings Fallback

You can still customize general extension behavior in VS Code `settings.json`:

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `ducklake.postgres.clientEncoding` | string | `"auto"` | Client character encoding (`auto`, `UTF8`, `WIN874`, `LATIN1`, `ISO_8859_5`, etc.). |
| `ducklake.catalogSchemas` | array | `["public", "main"]` | List of catalog schemas to scan. |
| `ducklake.autoRefreshMinutes` | number | `10` | Auto-refresh interval in minutes (0 to disable). |
| `ducklake.enableSmartHeuristic` | boolean | `true` | Detect SQL inside triple quotes automatically. |
| `ducklake.suggestDuckDBFunctions` | boolean | `true` | Suggest DuckDB window, list, and lakehouse analytical functions. |

---

## 📊 Status Bar Controls

The status bar at the bottom right displays the current status:
- `$(database) DuckLake: Connected (14 tables)`: Catalog is live and synchronized.
- Click the status bar item to open the menu:
  - 🔄 **Refresh Catalog Metadata**
  - 🔌 **Test Connection**
  - ⚙️ **Configure Connection (GUI)**
  - 📄 **Open connections.json**

---

## 👨‍💻 Creator & Author
Developed & Created by **takdanai.mp**

