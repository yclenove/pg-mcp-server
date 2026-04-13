# PostgreSQL MCP Server

[![npm version](https://img.shields.io/npm/v/@yclenove/pg-mcp-server.svg)](https://www.npmjs.com/package/@yclenove/pg-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)

**[简体中文](./README.md) | English**

A PostgreSQL database tool server based on [MCP (Model Context Protocol)](https://modelcontextprotocol.io/), exposing stdio JSON-RPC for Claude, Cursor, and other clients to query and optionally write data safely.

---

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Tools](#tools)
- [Resources and Prompts](#resources-and-prompts)
- [Security and read-only](#security-and-read-only)
- [Configuration](#configuration)
- [Client setup](#client-setup)
- [Local development](#local-development)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Changelog](#changelog)

---

## Features

- **Tools**: ~**20+** core MCP tools; optional ops / multi-DSN / slow-log tail tools when env vars are set (see [Tools](#tools)).
- **Safety**: parameterized queries; DELETE/UPDATE require WHERE; TRUNCATE/DROP/ALTER blocked; optional `PG_DATABASE_ALLOWLIST`.
- **Read-only**: `PG_READONLY=true` — tool layer + `default_transaction_read_only` on new connections.
- **Multi-DSN**: `PG_MCP_EXTRA_CONNECTIONS` + `list_connections` / `use_connection`.
- **EXPLAIN**: row-based plan + Chinese warnings; optional `PG_MCP_EXPLAIN_JSON` for `EXPLAIN (FORMAT JSON)`.
- **Token**: `schema/overview` can cap expanded tables; `MCP_QUERY_RESULT_HINT` adds approximate result size.
- **Audit / ops**: optional audit log, `pg_stat_activity`, log settings, slow-log file tail (each behind explicit flags).
- **Resources & Prompts**: four Resources and four Prompts (below).

---

## Architecture

```
MCP Client (Claude / Cursor)
    │  stdio JSON-RPC
    ▼
MCP Server (server.ts)
    ├── Query ───────────── query, explain_query
    ├── Modify ──────────── insert, update, delete, call_procedure
    ├── Schema ──────────── test_connection, use_database, show_databases,
    │                        list_tables, describe_table, show_indexes, show_create_table
    ├── Connections ─────── list_connections, use_connection
    ├── Ops (optional) ──── process_list, slow_query_status, kill_query,
    │                        read_audit_log, read_slow_query_log
    ├── Batch ───────────── batch_execute, batch_insert
    ├── DDL ─────────────── create_table
    ├── Resources ───────── postgresql://schema/overview, schema/table/{name},
    │                      databases, status/pool
    └── Prompts ─────────── analyze-table, generate-query, optimize-query, data-overview
    ▼
Executor (executor.ts) ← timeout / retry / dangerous SQL / audit
    ▼
Connection pool (connection.ts) ← multi-pool, read-only session, node-postgres (pg)
    ▼
PostgreSQL
```

---

## Quick start

### npx (recommended)

```bash
npx -y @yclenove/pg-mcp-server
```

### Global install

```bash
npm install -g @yclenove/pg-mcp-server
pg-mcp-server
```

### From source

```bash
git clone https://github.com/yclenove/pg-mcp-server.git
cd pg-mcp-server
npm install
npm run build
npm start
```

### Publish / rename

The published name comes from `package.json` → `name` (currently `@yclenove/pg-mcp-server`). You need scope permission to publish; to use another username, change `name` and run `npm publish --access public`, then update client `npx` args.

**GitHub Actions publish**: use a Granular or Automation npm token in Secret `NPM_TOKEN` if 2FA is enabled. See `.github/workflows/publish.yml`.

---

## Tools

### Query & analysis

| Tool            | Description                                                                               | Args                                             |
| --------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `query`         | Read-only SELECT / WITH / SHOW / EXPLAIN; `$n` placeholders; `limit` or `page`+`pageSize` | `sql`, `params?`, `limit?`, `page?`, `pageSize?` |
| `explain_query` | Plan; row EXPLAIN + warnings; `PG_MCP_EXPLAIN_JSON=true` uses `EXPLAIN (FORMAT JSON)`     | `sql`                                            |

### Metadata & connections

| Tool                | Description                                            | Args            |
| ------------------- | ------------------------------------------------------ | --------------- |
| `test_connection`   | Ping, version, `connectionId` / database               | —               |
| `use_database`      | `SET search_path` (allowlist); PostgreSQL semantics    | `database`      |
| `show_databases`    | List DBs (`pg_database`, allowlist filtered)           | —               |
| `list_tables`       | Tables in `public` for current DB                      | `database?`     |
| `describe_table`    | Columns                                                | `table`         |
| `show_indexes`      | Indexes (`pg_indexes`)                                 | `table`         |
| `show_create_table` | Approximate DDL                                        | `table`         |
| `list_connections`  | Configured ids / host / port / database (no passwords) | —               |
| `use_connection`    | Switch active connection                               | `connection_id` |

### Writes & batch

| Tool                           | Description                                    | Args                    |
| ------------------------------ | ---------------------------------------------- | ----------------------- |
| `insert` / `update` / `delete` | Parameterized; UPDATE/DELETE must have WHERE   | `sql`, `params?`        |
| `call_procedure`               | Call function/proc style                       | `procedure`, `params?`  |
| `batch_execute`                | Transaction batch, max 50 statements           | `statements[]`          |
| `batch_insert`                 | Bulk insert, max 50 rows                       | `table`, `records[]`    |
| `create_table`                 | CREATE TABLE (disabled when read-only; PG DDL) | `table`, `columns[]`, … |

### Optional ops (env-gated)

| Tool                  | Prerequisites                                                                  |
| --------------------- | ------------------------------------------------------------------------------ |
| `process_list`        | `PG_MCP_OPS_TOOLS=true`; row cap `PG_MCP_PROCESS_LIST_MAX`                     |
| `slow_query_status`   | `PG_MCP_OPS_TOOLS=true`                                                        |
| `kill_query`          | `PG_MCP_KILL_QUERY=true` (`pg_cancel_backend`); not allowed when `PG_READONLY` |
| `read_audit_log`      | `PG_MCP_READ_AUDIT_TOOL=true` and `MCP_AUDIT_LOG`                              |
| `read_slow_query_log` | `PG_MCP_READ_SLOW_LOG=true` and `PG_MCP_SLOW_LOG_PATH`                         |

---

## Resources and Prompts

### MCP Resources

| URI                                     | Description                                                                      |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `postgresql://schema/overview`          | Table/column summary; large schemas: limit with `MCP_SCHEMA_OVERVIEW_MAX_TABLES` |
| `postgresql://schema/table/{tableName}` | Single-table columns (JSON)                                                      |
| `postgresql://databases`                | Database names (JSON array, allowlist filtered)                                  |
| `postgresql://status/pool`              | Pool status                                                                      |

### MCP Prompts

| Prompt           | Description                         |
| ---------------- | ----------------------------------- |
| `analyze-table`  | Structure / indexes / row analysis  |
| `generate-query` | NL → parameterized SELECT + `query` |
| `optimize-query` | EXPLAIN + index and rewrite hints   |
| `data-overview`  | Database-level overview             |

Manual checklist: [MCP_CURSOR_TEST.md](./MCP_CURSOR_TEST.md).

---

## Security and read-only

- **Parameterized execution** on write paths.
- **Dangerous SQL**: DELETE/UPDATE require WHERE; TRUNCATE/DROP/ALTER blocked.
- **`PG_READONLY=true`**: (1) write tools rejected; (2) batch filters non-read-only; (3) executor validation; (4) new connections run `SET default_transaction_read_only = on`.

---

## Configuration

Create `.env` in the **project root** (copy [`.env.example`](./.env.example)); **do not commit `.env`**.

Load order (first match wins; `override: true` on load): **`PG_ENV_PATH`** (absolute path to any `.env`), then **`process.cwd()/.env`**, then **`<entry>/../.env`** (parent of `dist/` when running `node …/dist/index.js`, for hosts that do not set `cwd` to the repo root).

Legacy `MYSQL_*` names are still read as **fallback** in code for migration; prefer `PG_*` for new configs.

### Connection

| Var                                                | Default   | Description                                            |
| -------------------------------------------------- | --------- | ------------------------------------------------------ |
| `PG_HOST`                                          | localhost | Host                                                   |
| `PG_PORT`                                          | 5432      | Port                                                   |
| `PG_USER`                                          | postgres  | User                                                   |
| `PG_PASSWORD`                                      | —         | Password                                               |
| `PG_DATABASE`                                      | —         | Default database                                       |
| `PG_URL` / `DATABASE_URL` / `PG_CONNECTION_STRING` | —         | `postgresql://` or `postgres://`; URL-encode passwords |
| `PG_ENV_PATH`                                      | —         | Absolute path to a `.env`; set in MCP `env` if `cwd` is wrong |

### Safety & allowlist

| Var                                 | Description                                             |
| ----------------------------------- | ------------------------------------------------------- |
| `PG_DATABASE_ALLOWLIST`             | Comma-separated DB names                                |
| `PG_MCP_VALIDATE_EXTRA_CONNECTIONS` | `true` + allowlist → validate each extra DSN default DB |
| `PG_MAX_SQL_LENGTH`                 | Max SQL chars (default 102400)                          |

### Execution & pool

| Var                                  | Default | Description          |
| ------------------------------------ | ------- | -------------------- |
| `PG_MAX_ROWS`                        | 100     | Max rows             |
| `PG_QUERY_TIMEOUT`                   | 30000   | Query timeout (ms)   |
| `PG_RETRY_COUNT`                     | 2       | Read retry count     |
| `PG_RETRY_DELAY_MS`                  | 200     | Retry backoff        |
| `PG_CONNECTION_LIMIT`                | 10      | Pool size (`max`)    |
| `PG_TIMEOUT`                         | 60000   | Connect timeout (ms) |
| `PG_SSL_CA` / `SSL_CERT` / `SSL_KEY` | —       | SSL                  |

### Read-only, debug, MCP

| Var                              | Description                       |
| -------------------------------- | --------------------------------- |
| `PG_READONLY`                    | `true` read-only                  |
| `MCP_DEBUG`                      | `true` → extra timing fields      |
| `MCP_SCHEMA_OVERVIEW_MAX_TABLES` | Cap expanded tables in overview   |
| `MCP_AUDIT_LOG`                  | Audit log path                    |
| `MCP_QUERY_RESULT_HINT`          | `true` → `approxChars` on `query` |
| `PG_MCP_EXPLAIN_JSON`            | `true` → JSON EXPLAIN parsing     |

### Multi-DSN

| Var                        | Description                  |
| -------------------------- | ---------------------------- |
| `PG_MCP_EXTRA_CONNECTIONS` | JSON array of `{ id, url }`  |
| `PG_MCP_CONNECTION_ID`     | Active id, default `default` |

### Ops (optional)

| Var                       | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `PG_MCP_OPS_TOOLS`        | `true` → `process_list`, `slow_query_status`        |
| `PG_MCP_PROCESS_LIST_MAX` | Max rows for `process_list` (default 100, cap 5000) |
| `PG_MCP_KILL_QUERY`       | `true` → `kill_query`                               |
| `PG_MCP_READ_AUDIT_TOOL`  | + `MCP_AUDIT_LOG` → `read_audit_log`                |
| `PG_MCP_READ_SLOW_LOG`    | + `PG_MCP_SLOW_LOG_PATH` → `read_slow_query_log`    |
| `PG_MCP_SLOW_LOG_PATH`    | Slow log file path                                  |

---

## Client setup

### Claude Desktop

Edit `claude_desktop_config.json` (see Claude docs for paths on macOS/Windows):

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@yclenove/pg-mcp-server"],
      "env": {
        "PG_HOST": "localhost",
        "PG_PORT": "5432",
        "PG_USER": "postgres",
        "PG_PASSWORD": "your_password",
        "PG_DATABASE": "your_database"
      }
    }
  }
}
```

### Cursor

[![Add to Cursor](https://img.shields.io/badge/Add%20to-Cursor-6C47FF?logo=cursor&logoColor=white)](https://cursor.com/en/install-mcp?name=pg-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkB5Y2xlbm92ZS9wZy1tY3Atc2VydmVyQGxhdGVzdCJdfQ%3D%3D)

1. **Recommended for local dev**: `"command": "node"`, `"args": ["<repo>/dist/index.js"]` after `npm run build`. Even if `cwd` is your home directory, the server still tries **`<dist>/../.env`**. If the host never sets `cwd`, set **`PG_ENV_PATH`** in MCP `env` to the absolute `.env` path.
2. **Global install**: `npm install -g @yclenove/pg-mcp-server@latest` and ensure `pg-mcp-server` is on `PATH` (Windows: npm global bin). If your registry mirror lacks the package, use `--registry https://registry.npmjs.org/` with `npx` or set `@yclenove:registry`.
3. Put connection settings in **project root** `.env` (gitignored). **Do not** put production passwords in MCP `env` if you can rely on `.env`.
4. This repo **does not commit** `.cursor/`. Add the MCP server in Cursor settings, or create **local** `.cursor/mcp.json` under the project root (not committed), for example:

```json
{
  "mcpServers": {
    "pg-mcp": {
      "command": "pg-mcp-server",
      "args": [],
      "env": {}
    }
  }
}
```

5. **Precedence**: see “Load order” above; matched file overrides inherited `PG_*`.
6. Full manual checklist: [MCP_CURSOR_TEST.md](./MCP_CURSOR_TEST.md).

**Without global install**, use `npx` with `"args": ["-y", "--registry", "https://registry.npmjs.org/", "@yclenove/pg-mcp-server@latest"]`. If the npx cache is corrupted, delete `%LOCALAPPDATA%\\npm-cache\\_npx` (Windows) and retry.

### Production read-only example

```json
{
  "mcpServers": {
    "pg-prod": {
      "command": "npx",
      "args": ["-y", "@yclenove/pg-mcp-server"],
      "env": {
        "PG_HOST": "prod-db.example.com",
        "PG_USER": "readonly_user",
        "PG_PASSWORD": "password",
        "PG_DATABASE": "production",
        "PG_READONLY": "true"
      }
    }
  }
}
```

---

## Local development

1. `npm install` && `npm run build`
2. **Option A**: global `pg-mcp-server` + local `.cursor/mcp.json` (self-created, not committed)
3. **Option B**: `node` + `${workspaceFolder}/dist/index.js`, reload MCP
4. Follow [MCP_CURSOR_TEST.md](./MCP_CURSOR_TEST.md), or run `npm test` / `npm run inspector`

---

## Development

Read [AGENTS.md](./AGENTS.md) before adding tools/resources/prompts (token economy).

### Layout (partial)

```
src/
├── index.ts
├── server.ts
├── resources.ts
├── prompts.ts
├── db/
│   ├── connection.ts
│   ├── executor.ts
│   └── allowlist.ts
└── tools/
    ├── query.ts
    ├── modify.ts
    ├── schema.ts
    ├── connections.ts
    ├── ops.ts
    ├── batch.ts
    └── ddl.ts
test/
```

### Commands

```bash
npm run dev
npm run build
npm start
npm test
npm run lint
npm run format
npm run format:check
npm run inspector
```

### Docker

```bash
docker build -t pg-mcp-server .
docker run -e PG_HOST=host.docker.internal \
           -e PG_USER=postgres \
           -e PG_PASSWORD=password \
           -e PG_DATABASE=mydb \
           pg-mcp-server
```

---

## Troubleshooting

| Symptom                      | Fix                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Connection failed            | Check PostgreSQL listen / `pg_hba.conf`; host/port/user/password; Docker→host may need `host.docker.internal` |
| `.env` loaded but wrong host | Project `.env` overrides system `PG_*`                                                                        |
| Query timeout                | `PG_QUERY_TIMEOUT`, `PG_MAX_ROWS`                                                                             |
| Writes fail in read-only     | Expected; check `PG_READONLY`                                                                                 |
| SSL                          | `PG_SSL_*`                                                                                                    |
| Local build not used         | `npm run build`; MCP `node` path must point to `dist/index.js`                                                |

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).

## License

[MIT](./LICENSE)
