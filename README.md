# PostgreSQL MCP Server

[![npm version](https://img.shields.io/npm/v/@yclenove/pg-mcp-server.svg)](https://www.npmjs.com/package/@yclenove/pg-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)

**简体中文 | [English](./README_en.md)**

基于 [MCP（Model Context Protocol）](https://modelcontextprotocol.io/) 的 PostgreSQL 数据库工具服务，供 Claude / Cursor 等客户端通过 stdio 安全地查询与（可选）写入数据。

---

## 目录

- [特性概览](#特性概览)
- [架构](#架构)
- [快速开始](#快速开始)
- [工具一览](#工具一览)
- [Resources 与 Prompts](#resources-与-prompts)
- [安全与只读](#安全与只读)
- [配置说明](#配置说明)
- [客户端接入](#客户端接入)
- [本地开发与本仓库调试](#本地开发与本仓库调试)
- [开发与构建](#开发与构建)
- [故障排查](#故障排查)
- [更新日志](#更新日志)

---

## 特性概览

- **工具**：核心约 **20+** 个 MCP 工具；另可按环境变量启用多连接、运维、慢日志尾部等（见 [工具一览](#工具一览)）。
- **安全**：参数化查询；DELETE/UPDATE 须带 WHERE；拦截 TRUNCATE / DROP / ALTER；可选库白名单 `PG_DATABASE_ALLOWLIST`。
- **只读模式**：`PG_READONLY=true` 时工具层 + 会话层 `default_transaction_read_only` 双保险。
- **多 DSN**：`PG_MCP_EXTRA_CONNECTIONS` + `list_connections` / `use_connection`。
- **EXPLAIN**：行式计划 + 中文告警；可选 `PG_MCP_EXPLAIN_JSON` 解析 `EXPLAIN (FORMAT JSON)`。
- **Token**：`schema/overview` 可限制展开表数；`MCP_QUERY_RESULT_HINT` 可返回结果近似字符数。
- **审计 / 运维**：可选审计日志、`pg_stat_activity`、日志相关配置、慢日志文件尾部等（均需显式开关）。
- **资源与提示**：4 类 Resource、4 个 Prompt；详见下文。

---

## 架构

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
    ├── Ops（可选）──────── process_list, slow_query_status, kill_query,
    │                        read_audit_log, read_slow_query_log
    ├── Batch ───────────── batch_execute, batch_insert
    ├── DDL ─────────────── create_table
    ├── Resources ───────── postgresql://schema/overview, schema/table/{name},
    │                      databases, status/pool
    └── Prompts ─────────── analyze-table, generate-query, optimize-query, data-overview
    ▼
Executor (executor.ts) ← 超时 / 重试 / 危险语句 / 审计
    ▼
Connection Pool (connection.ts) ← 多池、只读会话、node-postgres (pg)
    ▼
PostgreSQL
```

---

## 快速开始

### npx（推荐）

```bash
npx -y @yclenove/pg-mcp-server
```

### 全局安装

```bash
npm install -g @yclenove/pg-mcp-server
pg-mcp-server
```

### 从源码

```bash
git clone https://github.com/yclenove/pg-mcp-server.git
cd pg-mcp-server
npm install
npm run build
npm start
```

### 自行发布 / 换包名

包名由 `package.json` 的 `name` 决定（当前为 `@yclenove/pg-mcp-server`）。发布需对应 npm 作用域权限；换用户名请改 `name` 后 `npm publish --access public`，客户端 `npx` 参数需同步。

**GitHub Actions 发布（避免 `npm error code EOTP`）**：若开启 2FA，请在 npm 创建 **Granular** 或 **Automation** 类 token，写入仓库 Secret `NPM_TOKEN`。详见 `.github/workflows/publish.yml` 顶部注释。

---

## 工具一览

### 查询与分析

| 工具            | 说明                                                                                       | 参数                                             |
| --------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `query`         | 只读 SELECT / WITH / SHOW / EXPLAIN；`$1` 占位；`limit` 或 `page`+`pageSize`               | `sql`, `params?`, `limit?`, `page?`, `pageSize?` |
| `explain_query` | 执行计划；默认行式 EXPLAIN + 告警；`PG_MCP_EXPLAIN_JSON=true` 时用 `EXPLAIN (FORMAT JSON)` | `sql`                                            |

### 元数据与连接

| 工具                | 说明                                                             | 参数            |
| ------------------- | ---------------------------------------------------------------- | --------------- |
| `test_connection`   | Ping、version、当前 `connectionId` / database                    | 无              |
| `use_database`      | `SET search_path` 切换 schema（受白名单约束；语义为 PostgreSQL） | `database`      |
| `show_databases`    | 列出库（`pg_database`，受白名单过滤）                            | 无              |
| `list_tables`       | 当前连接库下 `public` 表列表与元数据                             | `database?`     |
| `describe_table`    | 列结构                                                           | `table`         |
| `show_indexes`      | 索引（`pg_indexes`）                                             | `table`         |
| `show_create_table` | 近似建表 DDL（聚合生成）                                         | `table`         |
| `list_connections`  | 已配置连接 id / host / port / database（无密码）                 | 无              |
| `use_connection`    | 切换活动连接                                                     | `connection_id` |

### 写入与批量

| 工具                           | 说明                                         | 参数                    |
| ------------------------------ | -------------------------------------------- | ----------------------- |
| `insert` / `update` / `delete` | 参数化；UPDATE/DELETE 必须含 WHERE           | `sql`, `params?`        |
| `call_procedure`               | 调用函数/过程（`SELECT ...` 形式）           | `procedure`, `params?`  |
| `batch_execute`                | 事务批量，最多 50 条                         | `statements[]`          |
| `batch_insert`                 | 批量插入，最多 50 行                         | `table`, `records[]`    |
| `create_table`                 | 建表（只读模式禁用；DDL 为 PostgreSQL 方言） | `table`, `columns[]`, … |

### 可选运维（需环境变量）

| 工具                  | 前置条件                                                                |
| --------------------- | ----------------------------------------------------------------------- |
| `process_list`        | `PG_MCP_OPS_TOOLS=true`；行数上限 `PG_MCP_PROCESS_LIST_MAX`             |
| `slow_query_status`   | `PG_MCP_OPS_TOOLS=true`（`SHOW log_min_duration_statement` 等）         |
| `kill_query`          | `PG_MCP_KILL_QUERY=true`（`pg_cancel_backend`）；`PG_READONLY` 时不可用 |
| `read_audit_log`      | `PG_MCP_READ_AUDIT_TOOL=true` 且已设 `MCP_AUDIT_LOG`                    |
| `read_slow_query_log` | `PG_MCP_READ_SLOW_LOG=true` 且已设 `PG_MCP_SLOW_LOG_PATH`               |

---

## Resources 与 Prompts

### MCP Resources

| 资源 URI                                | 说明                                                                  |
| --------------------------------------- | --------------------------------------------------------------------- |
| `postgresql://schema/overview`          | 当前库表与列摘要；大库可限制展开表数 `MCP_SCHEMA_OVERVIEW_MAX_TABLES` |
| `postgresql://schema/table/{tableName}` | 单表列 JSON                                                           |
| `postgresql://databases`                | 库名 JSON 数组（受白名单过滤）                                        |
| `postgresql://status/pool`              | 连接池状态（`pg` Pool 指标）                                          |

### MCP Prompts

| Prompt           | 说明                               |
| ---------------- | ---------------------------------- |
| `analyze-table`  | 表结构 / 索引 / 行数分析           |
| `generate-query` | 自然语言 → 参数化 SELECT + `query` |
| `optimize-query` | EXPLAIN + 索引与改写建议           |
| `data-overview`  | 库级概览                           |

手动验收清单见 [MCP_CURSOR_TEST.md](./MCP_CURSOR_TEST.md)。

---

## 安全与只读

- **参数化**：写入类工具使用参数化执行，防止 SQL 注入。
- **危险语句**：DELETE/UPDATE 须含 WHERE；TRUNCATE / DROP / ALTER 拦截。
- **只读模式** `PG_READONLY=true`：
  1. 写入类工具拒绝；
  2. 批量中非只读语句拒绝；
  3. 执行层校验；
  4. 新建连接执行 `SET default_transaction_read_only = on`（会话级）。

---

## 配置说明

在**项目根目录**放置 `.env`（可复制 [`.env.example`](./.env.example)），启动时自动加载；**勿提交 `.env`**。

加载顺序（先命中者生效，且以 `override: true` 覆盖进程里已有同名变量）：① 环境变量 **`PG_ENV_PATH`** 指向的文件；② **`process.cwd()/.env`**；③ 入口脚本所在目录的上一级（即 **`dist/` 的上一级**，适用于 Cursor 未正确传入 `cwd`、但用 `node …/pg-mcp-server/dist/index.js` 启动）。若均未找到文件，则仅使用进程环境与默认行为。

为从 MySQL 版迁移，代码中仍支持部分旧 `MYSQL_*` 变量名作为**回退**（见源码 `src/db/connection.ts`），新配置请统一使用 `PG_*`。

### 连接与账号

| 变量                                               | 默认值    | 说明                                                            |
| -------------------------------------------------- | --------- | --------------------------------------------------------------- |
| `PG_HOST`                                          | localhost | 主机                                                            |
| `PG_PORT`                                          | 5432      | 端口                                                            |
| `PG_USER`                                          | postgres  | 用户                                                            |
| `PG_PASSWORD`                                      | -         | 密码                                                            |
| `PG_DATABASE`                                      | -         | 默认库                                                          |
| `PG_URL` / `DATABASE_URL` / `PG_CONNECTION_STRING` | -         | `postgresql://` 或 `postgres://`；与分项二选一；密码请 URL 编码 |
| `PG_ENV_PATH`                                      | -         | 绝对路径指向任意 `.env`；可在 MCP `env` 中设置，避免宿主 `cwd` 不对时读不到配置 |

### 安全与白名单

| 变量                                | 说明                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `PG_DATABASE_ALLOWLIST`             | 逗号分隔库名；影响启动校验、`use_database`、`list_tables`（指定库）、`show_databases`、Resource `postgresql://databases` |
| `PG_MCP_VALIDATE_EXTRA_CONNECTIONS` | `true` 且已设白名单时，校验每个额外 DSN 的默认库                                                                         |
| `PG_MAX_SQL_LENGTH`                 | 单条 SQL 最大字符数（默认 102400）                                                                                       |

### 执行与连接池

| 变量                                       | 默认值 | 说明                        |
| ------------------------------------------ | ------ | --------------------------- |
| `PG_MAX_ROWS`                              | 100    | 单次最大返回行数            |
| `PG_QUERY_TIMEOUT`                         | 30000  | 查询超时（毫秒）            |
| `PG_RETRY_COUNT`                           | 2      | 只读重试次数                |
| `PG_RETRY_DELAY_MS`                        | 200    | 重试退避基数                |
| `PG_CONNECTION_LIMIT`                      | 10     | 连接池大小（`pg` 的 `max`） |
| `PG_TIMEOUT`                               | 60000  | 连接超时（毫秒）            |
| `PG_SSL_CA` / `PG_SSL_CERT` / `PG_SSL_KEY` | -      | SSL                         |

### 只读、调试与 MCP

| 变量                             | 说明                                                   |
| -------------------------------- | ------------------------------------------------------ |
| `PG_READONLY`                    | `true` 只读模式                                        |
| `MCP_DEBUG`                      | `true` 时工具返回 `executionTime`                      |
| `MCP_SCHEMA_OVERVIEW_MAX_TABLES` | 默认 50；`0` 仅表名；Resource `schema/overview`        |
| `MCP_AUDIT_LOG`                  | 审计日志文件路径                                       |
| `MCP_QUERY_RESULT_HINT`          | `true` 时 `query` 返回 `approxChars`                   |
| `PG_MCP_EXPLAIN_JSON`            | `true` 时 `explain_query` 使用 `EXPLAIN (FORMAT JSON)` |

### 多 DSN

| 变量                       | 说明                                                        |
| -------------------------- | ----------------------------------------------------------- |
| `PG_MCP_EXTRA_CONNECTIONS` | JSON 数组，如 `[{"id":"replica","url":"postgresql://..."}]` |
| `PG_MCP_CONNECTION_ID`     | 当前活动连接 id，默认 `default`                             |

### 运维（可选）

| 变量                      | 说明                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `PG_MCP_OPS_TOOLS`        | `true` → `process_list`、`slow_query_status`                 |
| `PG_MCP_PROCESS_LIST_MAX` | `process_list` 最大行数（默认 100，上限 5000）               |
| `PG_MCP_KILL_QUERY`       | `true` → `kill_query`（`pg_cancel_backend`）                 |
| `PG_MCP_READ_AUDIT_TOOL`  | `true` 且已设 `MCP_AUDIT_LOG` → `read_audit_log`             |
| `PG_MCP_READ_SLOW_LOG`    | `true` 且已设 `PG_MCP_SLOW_LOG_PATH` → `read_slow_query_log` |
| `PG_MCP_SLOW_LOG_PATH`    | 慢查询日志文件路径（进程需可读）                             |

---

## 客户端接入

### Claude Desktop

编辑 `claude_desktop_config.json`（[macOS] `~/Library/Application Support/Claude/`、[Windows] `%APPDATA%/Claude/`）：

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

1. **推荐本地调试**：`"command": "node"`，`"args": ["<本仓库>/dist/index.js"]`（先 `npm run build`）。即使用户目录为进程 `cwd`，也会尝试加载 **`dist/` 上一级** 的 `.env`；若宿主始终不传 `cwd`，可在 MCP `env` 里设 **`PG_ENV_PATH`** 指向该 `.env` 的绝对路径。
2. **安装 npm 包（全局）**：`npm install -g @yclenove/pg-mcp-server@latest`，确保终端里能执行 `pg-mcp-server`（Windows 需保证 Node 的 npm 全局 `bin` 在 PATH 中）。国内镜像若缺包，请对 `npx` 加 `--registry https://registry.npmjs.org/` 或配置 `@yclenove:registry`。
3. **连接信息**：写在**项目根目录** `.env`（已在 `.gitignore`，勿提交密码）。**不要**在 MCP 配置的 `env` 里写生产密码；本地可空 `env`、仅依赖 `.env`。
4. **Cursor MCP 配置**：本仓库**不提交** `.cursor/`。请在 Cursor 设置中新增 MCP，或在本机创建 **项目根** `.cursor/mcp.json`（仅本地，勿提交），例如：

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

5. **环境变量优先级**：见上文「加载顺序」；命中文件后其中 `PG_*` 等会**覆盖**系统中已设置的同名变量。若要用系统环境覆盖 `.env`，需临时重命名或移走对应 `.env` / 取消 `PG_ENV_PATH`。
6. 全功能手动测试见 [MCP_CURSOR_TEST.md](./MCP_CURSOR_TEST.md)。

**不装全局**时推荐 `npx`（固定走 npm 官方源，避免镜像缺包；`PG_ENV_PATH` 仍指向你的 `.env`）：

```json
{
  "mcpServers": {
    "pg-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "--registry",
        "https://registry.npmjs.org/",
        "@yclenove/pg-mcp-server@latest"
      ],
      "cwd": "<本仓库根>",
      "env": {
        "npm_config_registry": "https://registry.npmjs.org/",
        "PG_ENV_PATH": "<本仓库根>/.env"
      }
    }
  }
}
```

若遇 npx 缓存装坏（缺 `dist/tools/*.js` 等），可清空 `%LOCALAPPDATA%\\npm-cache\\_npx` 后重试。

### 生产只读示例

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

## 本地开发与本仓库调试

1. **安装与编译**

   ```bash
   npm install
   npm run build
   ```

2. **方式 A：全局 `pg-mcp-server`**（与 npm 一致）  
   全局安装后，在本地 `.cursor/mcp.json`（自建、不提交）中配置 `command: "pg-mcp-server"`；连接信息读项目根 `.env`。

3. **方式 B：调试当前仓库构建产物**  
   MCP 配置中改为 **`node` + `${workspaceFolder}/dist/index.js`**，执行 `npm run build` 后重载 MCP。

4. **验证**  
   在 Cursor 中启用 MCP 后，按 [MCP_CURSOR_TEST.md](./MCP_CURSOR_TEST.md) 逐项调用工具；或执行 `npm test`、`npm run inspector` 调试。

---

## 开发与构建

扩展工具 / Resource / Prompt 前请阅读 [AGENTS.md](./AGENTS.md)（token 与描述约定）。

### 目录结构（节选）

```
src/
├── index.ts           # 入口，加载 .env
├── server.ts          # MCP Server 注册
├── resources.ts       # Resources
├── prompts.ts         # Prompts
├── audit.ts
├── explainWarnings.ts
├── schemaOverviewLimit.ts
├── db/
│   ├── connection.ts  # 多池、只读会话、配置
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
test/                    # *.test.mjs
```

### 常用命令

```bash
npm run dev          # tsc --watch
npm run build        # 编译
npm start            # 启动 MCP
npm test             # 单元测试
npm run lint
npm run format
npm run format:check
npm run inspector    # MCP Inspector
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

## 故障排查

| 现象                                                       | 处理                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 连接失败                                                   | 检查 PostgreSQL 监听与 `pg_hba.conf`；核对 `host/port/user/password`；容器访问宿主机可用 `host.docker.internal`（视系统而定） |
| 日志已写「Loading .env from: …\\.env」，但下一行地址仍不对 | 项目 `.env` 会覆盖系统里同名 `PG_*`。检查 `.env` 内容                                                                         |
| 查询超时                                                   | 增大 `PG_QUERY_TIMEOUT`；大结果配合 `PG_MAX_ROWS`                                                                             |
| 只读下写入报错                                             | 预期行为；检查 `PG_READONLY`                                                                                                  |
| SSL                                                        | 设置 `PG_SSL_CA` 等                                                                                                           |
| MCP 未加载本地构建                                         | 确认已 `npm run build`，工作区根为本仓库，且 MCP 中 `node` 路径指向 `dist/index.js`                                           |

---

## 更新日志

详见 [CHANGELOG.md](./CHANGELOG.md)。

## License

[MIT](./LICENSE)
