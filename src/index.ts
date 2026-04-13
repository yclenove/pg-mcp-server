#!/usr/bin/env node
/**
 * PostgreSQL MCP Server 入口文件
 *
 * 环境变量配置（优先级从高到低）：
 * 1. `PG_ENV_PATH` 指向的文件（若设置）
 * 2. `process.cwd()/.env`（MCP 客户端若未传 cwd，此项可能落在用户主目录，不一定存在）
 * 3. 入口脚本所在包根目录下的 `.env`（即 `dist/` 的上一级；`node …/pg-mcp-server/dist/index.js` 时稳定指向仓库根）
 * 4. 以上文件均用 dotenv `override: true` 加载；再与进程继承的环境变量合并；未覆盖的键仍来自进程环境
 * 5. PG_URL / DATABASE_URL 等在连接层解析出的字段
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from './server.js';
import {
  testConnectionWithDetails,
  closePool,
  getConfigFromEnv,
  initConnectionPools,
  pingConnectionById,
  getExtraConnectionIds,
  parseExtraConnections,
} from './db/connection.js';
import {
  getDatabaseAllowlist,
  validateStartupDatabaseAgainstAllowlist,
  validateExtraConnectionsAgainstAllowlist,
} from './db/allowlist.js';

// 智能加载 .env 文件（按优先级）
function loadEnvFile(): string {
  const paths: string[] = [];

  const pgEnvPath = process.env.PG_ENV_PATH?.trim();
  if (pgEnvPath) {
    paths.push(resolve(pgEnvPath));
  }

  paths.push(join(process.cwd(), '.env'));

  const entryDir = dirname(fileURLToPath(import.meta.url));
  paths.push(join(entryDir, '..', '.env'));

  for (const envPath of paths) {
    // 日志输出到 stderr，避免干扰 stdio 通信
    console.error(`[PG MCP] Loading .env from: ${envPath}`);
    if (existsSync(envPath)) {
      dotenvConfig({ path: envPath, override: true });
      return envPath;
    }
  }

  // 都没有找到，使用默认行为
  dotenvConfig();
  return 'default (not found)';
}

const loadedEnvPath = loadEnvFile();

// 日志输出到 stderr，避免干扰 stdio 通信
function log(message: string): void {
  console.error(`[PG MCP] ${message}`);
}

async function main() {
  log('Starting PostgreSQL MCP Server...');
  log(`Loaded .env from: ${loadedEnvPath}`);
  log(`Working directory: ${process.cwd()}`);

  // 显示配置信息
  const config = getConfigFromEnv();
  log(
    `PostgreSQL: ${config.host}:${config.port}/${config.database || '(no db)'} (readonly: ${(process.env.PG_READONLY || process.env.MYSQL_READONLY) === 'true'})`
  );

  try {
    getDatabaseAllowlist();
    validateStartupDatabaseAgainstAllowlist();
    const extras = parseExtraConnections(
      process.env.PG_MCP_EXTRA_CONNECTIONS || process.env.MYSQL_MCP_EXTRA_CONNECTIONS
    );
    validateExtraConnectionsAgainstAllowlist(extras);
  } catch (e) {
    log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  try {
    initConnectionPools();
  } catch (e) {
    log(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  // 必须先 attach stdio：若在 testConnection 之后才 connect，客户端长时间收不到 MCP 握手，
  // Cursor 等会表现为已连接但「No tools, prompts, or resources」。
  await server.connect(transport);

  // 测试数据库连接（stdio 已就绪后再做网络探测，避免阻塞 MCP 发现工具列表）
  const connectionResult = await testConnectionWithDetails();

  if (!connectionResult.success) {
    const code = connectionResult.code ? ` [${connectionResult.code}]` : '';
    log(
      `ERROR: Failed to connect to PostgreSQL database${code}: ${connectionResult.error || 'unknown error'}`
    );
    process.exit(1);
  }

  log('Connected!');

  for (const id of getExtraConnectionIds()) {
    const ping = await pingConnectionById(id);
    if (!ping.success) {
      log(`WARN: 额外连接「${id}」不可用: ${ping.error || 'unknown'}`);
    }
  }

  log(
    `Ready — Tools: ${Object.keys((server as any)._registeredTools || {}).length}, ` +
      `Resources: ${Object.keys((server as any)._registeredResources || {}).length + Object.keys((server as any)._registeredResourceTemplates || {}).length}, ` +
      `Prompts: ${Object.keys((server as any)._registeredPrompts || {}).length}`
  );

  // 处理进程退出
  process.on('SIGINT', async () => {
    await closePool();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await closePool();
    process.exit(0);
  });
}

main().catch(async (error) => {
  console.error('Fatal error:', error);
  await closePool();
  process.exit(1);
});
