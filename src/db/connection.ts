/**
 * 数据库连接池管理（支持默认连接 + PG_MCP_EXTRA_CONNECTIONS 多 DSN）
 */
import { Pool, PoolConfig, type PoolClient } from 'pg';
import { DatabaseConfig } from '../types/index.js';

export const DEFAULT_CONNECTION_ID = 'default';

const CONNECTION_ID_REGEX = /^[A-Za-z0-9_]+$/;

const pools = new Map<string, Pool>();
/** 无密码，供 list_connections */
const connectionMeta = new Map<string, { host: string; port: number; database?: string }>();
/** 非 default 连接在 set search_path 后的当前 schema */
const sessionDatabaseById = new Map<string, string>();

let poolsInitialized = false;

/**
 * 解析 postgres 连接串（密码等请使用 URL 编码，如 `p%40ss`）。
 * 与 `PG_HOST` 等分项变量二选一；若同时存在，连接串字段优先，未给出的字段仍可由环境变量补全。
 */
export function parsePostgresConnectionUrl(
  urlStr: string
): Partial<Pick<DatabaseConfig, 'host' | 'port' | 'user' | 'password' | 'database'>> | null {
  const trimmed = urlStr.trim();
  if (!trimmed) return null;

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }

  const proto = u.protocol.replace(/:$/, '').toLowerCase();
  if (proto !== 'postgres' && proto !== 'postgresql') {
    return null;
  }

  const pathPart = u.pathname.replace(/^\//, '');
  const database = pathPart.split('?')[0] || undefined;

  return {
    host: u.hostname || undefined,
    port: u.port ? parseInt(u.port, 10) : undefined,
    user: u.username !== '' ? decodeURIComponent(u.username) : undefined,
    password: u.password !== '' ? decodeURIComponent(u.password) : undefined,
    database: database || undefined,
  };
}

// 兼容旧测试与调用方命名
export const parseMysqlConnectionUrl = parsePostgresConnectionUrl;

function pickEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && String(value).trim() !== '') return value;
  }
  return undefined;
}

function mergeUrlWithEnv(): Partial<
  Pick<DatabaseConfig, 'host' | 'port' | 'user' | 'password' | 'database'>
> {
  const raw = pickEnv('PG_URL', 'DATABASE_URL', 'PG_CONNECTION_STRING', 'MYSQL_URL');
  if (!raw) return {};
  const parsed = parsePostgresConnectionUrl(raw);
  return parsed ?? {};
}

function sslFromEnv(): DatabaseConfig['ssl'] {
  const sslCa = pickEnv('PG_SSL_CA', 'MYSQL_SSL_CA');
  const sslCert = pickEnv('PG_SSL_CERT', 'MYSQL_SSL_CERT');
  const sslKey = pickEnv('PG_SSL_KEY', 'MYSQL_SSL_KEY');
  if (sslCa || sslCert || sslKey) {
    return { ca: sslCa, cert: sslCert, key: sslKey };
  }
  return undefined;
}

/**
 * 分项环境变量 + 通用池参数（不含 URL），用于额外连接项合并
 */
export function getDiscreteConfigBase(): DatabaseConfig {
  return {
    host: pickEnv('PG_HOST', 'MYSQL_HOST') ?? 'localhost',
    port: parseInt(pickEnv('PG_PORT', 'MYSQL_PORT') || '5432', 10),
    user: pickEnv('PG_USER', 'MYSQL_USER') ?? 'postgres',
    password: pickEnv('PG_PASSWORD', 'MYSQL_PASSWORD') ?? '',
    database: pickEnv('PG_DATABASE', 'MYSQL_DATABASE'),
    connectionLimit: parseInt(pickEnv('PG_CONNECTION_LIMIT', 'MYSQL_CONNECTION_LIMIT') || '10', 10),
    queueLimit: parseInt(pickEnv('PG_QUEUE_LIMIT', 'MYSQL_QUEUE_LIMIT') || '0', 10),
    timeout: parseInt(pickEnv('PG_TIMEOUT', 'MYSQL_TIMEOUT') || '60000', 10),
    queryTimeout: parseInt(pickEnv('PG_QUERY_TIMEOUT', 'MYSQL_QUERY_TIMEOUT') || '30000', 10),
    retryCount: parseInt(pickEnv('PG_RETRY_COUNT', 'MYSQL_RETRY_COUNT') || '2', 10),
    retryDelayMs: parseInt(pickEnv('PG_RETRY_DELAY_MS', 'MYSQL_RETRY_DELAY_MS') || '200', 10),
    maxRows: parseInt(pickEnv('PG_MAX_ROWS', 'MYSQL_MAX_ROWS') || '100', 10),
    ssl: sslFromEnv(),
  };
}

/**
 * 从环境变量获取数据库配置（含 URL）
 */
export function getConfigFromEnv(): DatabaseConfig {
  const fromUrl = mergeUrlWithEnv();
  const base = getDiscreteConfigBase();
  return {
    ...base,
    host: fromUrl.host ?? base.host,
    port: fromUrl.port ?? base.port,
    user: fromUrl.user ?? base.user,
    password: fromUrl.password ?? base.password,
    database: fromUrl.database ?? base.database,
  };
}

export type ParsedExtraConnection = { id: string; config: DatabaseConfig };

/**
 * 解析 PG_MCP_EXTRA_CONNECTIONS JSON，供启动校验与单测
 */
export function parseExtraConnections(raw: string | undefined): ParsedExtraConnection[] {
  if (raw === undefined || String(raw).trim() === '') {
    return [];
  }
  let arr: unknown[];
  try {
    arr = JSON.parse(String(raw)) as unknown[];
  } catch {
    throw new Error('PG_MCP_EXTRA_CONNECTIONS 不是合法 JSON');
  }
  if (!Array.isArray(arr)) {
    throw new Error('PG_MCP_EXTRA_CONNECTIONS 须为 JSON 数组');
  }

  const seen = new Set<string>();
  const out: ParsedExtraConnection[] = [];

  for (const item of arr) {
    if (item === null || typeof item !== 'object') {
      throw new Error('PG_MCP_EXTRA_CONNECTIONS 数组元素须为对象');
    }
    const entry = item as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== 'string' || !CONNECTION_ID_REGEX.test(id)) {
      throw new Error('每个连接须包含合法 id（字母数字下划线）');
    }
    if (id === DEFAULT_CONNECTION_ID) {
      throw new Error(`额外连接 id 不能为 ${DEFAULT_CONNECTION_ID}`);
    }
    if (seen.has(id)) {
      throw new Error(`PG_MCP_EXTRA_CONNECTIONS 中 id「${id}」重复`);
    }
    seen.add(id);

    const base = getDiscreteConfigBase();
    let config: DatabaseConfig;

    if (typeof entry.url === 'string' && entry.url.trim() !== '') {
      const p = parsePostgresConnectionUrl(entry.url);
      if (!p) {
        throw new Error(`连接「${id}」的 url 无效`);
      }
      config = {
        ...base,
        host: p.host ?? base.host,
        port: p.port ?? base.port,
        user: p.user ?? base.user,
        password: p.password ?? base.password,
        database: p.database ?? base.database,
      };
    } else {
      config = {
        ...base,
        host: entry.host !== undefined ? String(entry.host) : base.host,
        port: entry.port !== undefined ? parseInt(String(entry.port), 10) || base.port : base.port,
        user: entry.user !== undefined ? String(entry.user) : base.user,
        password: entry.password !== undefined ? String(entry.password) : base.password,
        database: entry.database !== undefined ? String(entry.database) : base.database,
      };
    }

    out.push({ id, config });
  }

  return out;
}

function createPgPool(config: DatabaseConfig): Pool {
  const poolConfig: PoolConfig = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    max: config.connectionLimit,
    connectionTimeoutMillis: config.timeout,
    ssl: config.ssl ? { ca: config.ssl.ca, cert: config.ssl.cert, key: config.ssl.key } : undefined,
  };
  const pool = new Pool(poolConfig);
  if (isReadOnly()) {
    pool.on('connect', (client: PoolClient) => {
      void client.query('SET default_transaction_read_only = on');
    });
  }
  return pool;
}

function setMeta(id: string, config: DatabaseConfig): void {
  connectionMeta.set(id, {
    host: config.host,
    port: config.port,
    database: config.database,
  });
  const db = config.database?.trim();
  if (db) {
    sessionDatabaseById.set(id, db);
  }
}

/**
 * 初始化所有连接池（默认 + 额外）。重复调用为 no-op。
 */
export function initConnectionPools(): void {
  if (poolsInitialized) {
    return;
  }

  const defaultConfig = getConfigFromEnv();
  pools.set(DEFAULT_CONNECTION_ID, createPgPool(defaultConfig));
  setMeta(DEFAULT_CONNECTION_ID, defaultConfig);

  const extras = parseExtraConnections(
    pickEnv('PG_MCP_EXTRA_CONNECTIONS', 'MYSQL_MCP_EXTRA_CONNECTIONS')
  );
  for (const { id, config } of extras) {
    pools.set(id, createPgPool(config));
    setMeta(id, config);
  }

  poolsInitialized = true;
}

export function getActiveConnectionId(): string {
  const raw = pickEnv('PG_MCP_CONNECTION_ID', 'MYSQL_MCP_CONNECTION_ID');
  if (raw === undefined || String(raw).trim() === '') {
    return DEFAULT_CONNECTION_ID;
  }
  return String(raw).trim();
}

/**
 * 当前活动连接上的默认库（连接串 / PG_DATABASE）
 */
export function getSessionDatabase(): string | undefined {
  const id = getActiveConnectionId();
  if (id === DEFAULT_CONNECTION_ID) {
    const envDb = pickEnv('PG_DATABASE', 'MYSQL_DATABASE')?.trim();
    if (envDb) {
      return envDb;
    }
    return connectionMeta.get(id)?.database;
  }
  return sessionDatabaseById.get(id) ?? connectionMeta.get(id)?.database;
}

/**
 * use_database 成功后更新会话库
 */
export function setSessionDatabaseForActiveConnection(database: string): void {
  const id = getActiveConnectionId();
  if (id === DEFAULT_CONNECTION_ID) {
    process.env.PG_DATABASE = database;
  }
  sessionDatabaseById.set(id, database);
}

export function listConnectionDescriptors(): {
  id: string;
  host: string;
  port: number;
  database?: string;
}[] {
  return [...connectionMeta.entries()].map(([id, m]) => ({
    id,
    host: m.host,
    port: m.port,
    database: m.database,
  }));
}

export function setActiveConnectionId(
  connectionId: string
): { ok: true } | { ok: false; error: string } {
  const id = connectionId.trim();
  if (!CONNECTION_ID_REGEX.test(id)) {
    return { ok: false, error: 'connection_id 仅允许字母、数字、下划线' };
  }
  if (!pools.has(id)) {
    return { ok: false, error: `未知连接 id「${id}」，请先配置 PG_MCP_EXTRA_CONNECTIONS` };
  }
  process.env.PG_MCP_CONNECTION_ID = id;
  return { ok: true };
}

/**
 * 按活动连接 id 获取池；首次访问时初始化
 */
export function getPool(): Pool {
  initConnectionPools();
  const id = getActiveConnectionId();
  const p = pools.get(id);
  if (!p) {
    throw new Error(`内部错误：未找到连接池「${id}」`);
  }
  return p;
}

/**
 * 获取连接
 */
export async function getConnection(): Promise<PoolClient> {
  const pool = getPool();
  return await pool.connect();
}

/**
 * 关闭所有连接池
 */
export async function closePool(): Promise<void> {
  const toClose = [...pools.values()];
  pools.clear();
  connectionMeta.clear();
  sessionDatabaseById.clear();
  poolsInitialized = false;
  await Promise.all(toClose.map((p) => p.end().catch(() => undefined)));
}

/**
 * 测试连接
 */
export async function testConnection(): Promise<boolean> {
  try {
    const conn = await getConnection();
    await conn.query('SELECT 1');
    conn.release();
    return true;
  } catch (_error) {
    return false;
  }
}

export async function testConnectionWithDetails(): Promise<{
  success: boolean;
  error?: string;
  code?: string;
}> {
  try {
    const conn = await getConnection();
    await conn.query('SELECT 1');
    conn.release();
    return { success: true };
  } catch (error) {
    const err = error as { message?: string; code?: string };
    return {
      success: false,
      error: err?.message || '未知连接错误',
      code: err?.code,
    };
  }
}

/**
 * 对指定连接 id 做 SELECT 1（不改变活动连接）
 */
export async function pingConnectionById(
  id: string
): Promise<{ success: boolean; error?: string }> {
  initConnectionPools();
  const p = pools.get(id);
  if (!p) {
    return { success: false, error: `未知连接「${id}」` };
  }
  try {
    const conn = await p.connect();
    await conn.query('SELECT 1');
    conn.release();
    return { success: true };
  } catch (error) {
    const err = error as { message?: string };
    return { success: false, error: err?.message || '未知错误' };
  }
}

export function getExtraConnectionIds(): string[] {
  return parseExtraConnections(
    pickEnv('PG_MCP_EXTRA_CONNECTIONS', 'MYSQL_MCP_EXTRA_CONNECTIONS')
  ).map((x) => x.id);
}

/**
 * 检查是否为只读模式
 */
export function isReadOnly(): boolean {
  return pickEnv('PG_READONLY', 'MYSQL_READONLY') === 'true';
}

/**
 * 检查是否为调试模式（返回 executionTime 等额外信息）
 */
export function isDebugMode(): boolean {
  return process.env.MCP_DEBUG === 'true';
}
