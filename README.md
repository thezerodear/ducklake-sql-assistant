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
  - Auto-refresh background timer with real-time status indicator in the VS Code status bar.

---

## 🛠️ Quick Start & Installation

### 1. Build the Extension

Open a terminal in this directory:
```bash
cd C:\Users\theze\.gemini\antigravity\scratch\ducklake-sql-extension
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

## ⚙️ Configuration Settings

Configure these in your VS Code `settings.json` or through GUI Settings (`Ctrl+,` -> search `ducklake`):

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `ducklake.postgres.connectionString` | string | `""` | Complete PostgreSQL URI (e.g. `postgresql://user:pass@localhost:5432/ducklake_db`). Overrides other settings. |
| `ducklake.postgres.host` | string | `"localhost"` | PostgreSQL catalog host. |
| `ducklake.postgres.port` | number | `5432` | PostgreSQL port. |
| `ducklake.postgres.database` | string | `"postgres"` | Database containing the DuckLake catalog tables. |
| `ducklake.postgres.user` | string | `"postgres"` | Database user. |
| `ducklake.postgres.password` | string | `""` | Database password. |
| `ducklake.postgres.ssl` | boolean | `false` | Enable SSL connection. |
| `ducklake.catalogSchemas` | array | `["public"]` | List of PostgreSQL schemas to scan for tables/columns. |
| `ducklake.autoRefreshMinutes` | number | `10` | Auto-refresh interval in minutes (0 to disable). |
| `ducklake.enableSmartHeuristic` | boolean | `true` | Detect SQL inside triple quotes automatically. |
| `ducklake.suggestDuckDBFunctions` | boolean | `true` | Suggest DuckDB analytical and Lakehouse functions. |

---

## 📊 Status Bar Controls

The status bar at the bottom right displays the current status:
- `$(database) DuckLake: Connected (14 tables)`: Catalog is live and synchronized.
- Click the status bar item to open the menu:
  - 🔄 **Refresh Catalog Metadata**
  - 🔌 **Test Connection**
  - ⚙️ **Configure Connection Settings**

---

## 👨‍💻 Creator & Author
Developed & Created by **takdanai.mp**

