/**
 * SQL 执行器（PostgreSQL）
 */
import { getPool, getConnection, getSessionDatabase } from './connection.js';
import { QueryResult, BatchResult, ExecutionMode } from '../types/index.js';
import { auditLog } from '../audit.js';
import type { QueryResult as PgQueryResult } from 'pg';

const IDENTIFIER_REGEX = /^[A-Za-z0-9_]+$/;
const RETRIABLE_ERROR_CODES = new Set(['40P01', '55P03', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/**
 * 判断 SQL 是否为只读查询
 */
export function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase();
  // 只允许查询类语句
  return (
    trimmed.startsWith('select') ||
    trimmed.startsWith('with') ||
    trimmed.startsWith('show') ||
    trimmed.startsWith('explain')
  );
}

/**
 * 校验 SQL 标识符（表名、列名等）
 */
export function validateIdentifier(name: string, fieldName: string = '标识符'): string | null {
  if (!name || typeof name !== 'string') {
    return `${fieldName}不能为空`;
  }
  if (!IDENTIFIER_REGEX.test(name)) {
    return `${fieldName}不合法，仅支持字母、数字和下划线`;
  }
  return null;
}

/**
 * 转义 SQL 标识符
 */
export function escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function stripQuotedContentAndComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, ' ')
    .replace(/#.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:\\"|[^"])*"/g, '""')
    .replace(/`(?:``|[^`])*`/g, '``');
}

function getRuntimeConfig() {
  return {
    queryTimeout: parseInt(
      process.env.PG_QUERY_TIMEOUT || process.env.MYSQL_QUERY_TIMEOUT || '30000',
      10
    ),
    retryCount: parseInt(process.env.PG_RETRY_COUNT || process.env.MYSQL_RETRY_COUNT || '2', 10),
    retryDelayMs: parseInt(
      process.env.PG_RETRY_DELAY_MS || process.env.MYSQL_RETRY_DELAY_MS || '200',
      10
    ),
    maxRows: parseInt(process.env.PG_MAX_ROWS || process.env.MYSQL_MAX_ROWS || '100', 10),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return !!code && RETRIABLE_ERROR_CODES.has(code);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`查询超时（>${timeoutMs}ms）`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer!);
  }
}

async function executeWithRetry<T>(runner: () => Promise<T>, allowRetry: boolean): Promise<T> {
  const { retryCount, retryDelayMs } = getRuntimeConfig();
  const attempts = Math.max(0, retryCount) + 1;
  for (let i = 0; i < attempts; i++) {
    try {
      return await runner();
    } catch (error) {
      const shouldRetry = allowRetry && i < attempts - 1 && isRetriableError(error);
      if (!shouldRetry) {
        throw error;
      }
      const backoff = Math.max(50, retryDelayMs) * Math.pow(2, i);
      const jitter = Math.floor(Math.random() * 50);
      await sleep(backoff + jitter);
    }
  }
  throw new Error('查询执行失败');
}

/**
 * 检查危险操作
 */
function checkDangerousOperation(sql: string): string | null {
  const normalized = stripQuotedContentAndComments(sql).trim().toLowerCase();

  if (normalized.startsWith('truncate')) {
    return '危险操作：TRUNCATE 会清空整张表数据，拒绝执行';
  }

  if (normalized.startsWith('drop')) {
    return '危险操作：DROP 会删除数据库对象，拒绝执行';
  }

  if (normalized.startsWith('alter')) {
    return '危险操作：ALTER 会修改表结构，拒绝执行。如需 DDL 操作请直接使用数据库客户端';
  }

  const isDeleteOrUpdate = normalized.startsWith('delete') || normalized.startsWith('update');
  const hasWhere = /\bwhere\b/.test(normalized);
  if (isDeleteOrUpdate && !hasWhere) {
    return '危险操作：DELETE 或 UPDATE 语句缺少 WHERE 子句，拒绝执行';
  }

  return null;
}

/**
 * 执行 SQL 查询
 */
export async function executeQuery(
  sql: string,
  params?: any[],
  mode: ExecutionMode = ExecutionMode.READWRITE,
  overrideMaxRows?: number
): Promise<QueryResult> {
  const startTime = Date.now();

  try {
    const maxSqlLength = parseInt(
      process.env.PG_MAX_SQL_LENGTH || process.env.MYSQL_MAX_SQL_LENGTH || '102400',
      10
    );
    if (sql.length > maxSqlLength) {
      return {
        success: false,
        error: `SQL 语句超过长度限制（${maxSqlLength} 字符），请拆分或精简`,
      };
    }

    if (mode === ExecutionMode.READONLY && !isReadOnlyQuery(sql)) {
      return {
        success: false,
        error: '当前处于只读模式，只允许执行 SELECT 查询',
      };
    }

    const dangerCheck = checkDangerousOperation(sql);
    if (dangerCheck) {
      return {
        success: false,
        error: dangerCheck,
      };
    }

    const pool = getPool();
    const { queryTimeout, maxRows } = getRuntimeConfig();
    const effectiveMaxRows = Math.max(1, overrideMaxRows ?? maxRows);
    const result = await executeWithRetry<PgQueryResult<any>>(
      () => withTimeout(pool.query(sql, params), queryTimeout),
      isReadOnlyQuery(sql)
    );
    const executionTime = Date.now() - startTime;

    if (isReadOnlyQuery(sql)) {
      auditLog({ sql, params, success: true, executionTime });
      return {
        success: true,
        data: result.rows.slice(0, effectiveMaxRows),
        totalRows: result.rows.length,
        truncated: result.rows.length > effectiveMaxRows,
        executionTime,
      };
    }
    auditLog({ sql, params, success: true, executionTime, affectedRows: result.rowCount || 0 });
    return {
      success: true,
      affectedRows: result.rowCount || 0,
      message: `执行成功，影响 ${result.rowCount || 0} 行`,
      executionTime,
    };
  } catch (error) {
    const executionTime = Date.now() - startTime;
    const errorMsg = friendlyError(error);
    auditLog({ sql, params, success: false, error: errorMsg, executionTime });
    return {
      success: false,
      error: errorMsg,
      executionTime,
    };
  }
}

const PG_ERROR_MAP: Record<string, string> = {
  '42P01': '表不存在',
  '3D000': '数据库不存在',
  '23505': '唯一键冲突，记录已存在',
  '28P01': '数据库访问被拒绝，请检查用户名和密码',
  '42501': '无权访问该对象',
  '42P07': '表已存在',
  '42703': '字段名不存在',
  '42601': 'SQL 语法错误',
  '23502': '字段缺少必填值',
  '22001': '数据超出字段长度限制',
  '22P02': '数据类型不匹配',
  '40P01': '死锁，事务已回滚',
  '55P03': '锁等待超时',
  ECONNREFUSED: '无法连接数据库，连接被拒绝',
  ENOTFOUND: '数据库主机地址无法解析',
  ETIMEDOUT: '数据库连接超时',
  '57P01': '数据库连接已断开',
};

function friendlyError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  const raw = error instanceof Error ? error.message : '未知错误';
  if (code && PG_ERROR_MAP[code]) {
    return `${PG_ERROR_MAP[code]}（${code}：${raw}）`;
  }
  return raw;
}

/**
 * 批量执行 SQL（事务）
 */
export async function executeBatch(
  statements: { sql: string; params?: any[] }[],
  mode: ExecutionMode = ExecutionMode.READWRITE
): Promise<BatchResult> {
  const startTime = Date.now();
  const results: QueryResult[] = [];
  let successCount = 0;
  let errorCount = 0;

  // 检查只读模式
  if (mode === ExecutionMode.READONLY) {
    for (const stmt of statements) {
      if (!isReadOnlyQuery(stmt.sql)) {
        return {
          success: false,
          results: [],
          totalStatements: statements.length,
          successCount: 0,
          errorCount: statements.length,
          error: '当前处于只读模式，批量执行中包含非 SELECT 语句',
        };
      }
    }
  }

  const conn = await getConnection();

  try {
    // 开始事务
    await conn.query('BEGIN');

    for (const { sql, params } of statements) {
      // 检查危险操作
      const dangerCheck = checkDangerousOperation(sql);
      if (dangerCheck) {
        await conn.query('ROLLBACK');
        return {
          success: false,
          results,
          totalStatements: statements.length,
          successCount,
          errorCount: statements.length - successCount,
          error: dangerCheck,
        };
      }

      try {
        const { queryTimeout, maxRows } = getRuntimeConfig();
        const result = await executeWithRetry<PgQueryResult<any>>(
          () => withTimeout(conn.query(sql, params), queryTimeout),
          isReadOnlyQuery(sql)
        );

        if (isReadOnlyQuery(sql)) {
          results.push({
            success: true,
            data: result.rows.slice(0, Math.max(1, maxRows)),
            totalRows: result.rows.length,
            truncated: result.rows.length > Math.max(1, maxRows),
          });
        } else {
          results.push({
            success: true,
            affectedRows: result.rowCount || 0,
            message: `执行成功，影响 ${result.rowCount || 0} 行`,
          });
        }
        successCount++;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : '未知错误';
        results.push({
          success: false,
          error: errorMsg,
        });
        errorCount++;
        // 出错时回滚事务
        await conn.query('ROLLBACK');
        return {
          success: false,
          results,
          totalStatements: statements.length,
          successCount,
          errorCount,
          error: `批量执行在第 ${results.length} 条语句失败：${errorMsg}`,
        };
      }
    }

    // 提交事务
    await conn.query('COMMIT');

    const executionTime = Date.now() - startTime;
    results.forEach((r) => (r.executionTime = executionTime));

    return {
      success: true,
      results,
      totalStatements: statements.length,
      successCount,
      errorCount,
    };
  } catch (error) {
    await conn.query('ROLLBACK');
    const errorMsg = error instanceof Error ? error.message : '未知错误';
    return {
      success: false,
      results,
      totalStatements: statements.length,
      successCount,
      errorCount: statements.length - successCount,
      error: `事务执行失败：${errorMsg}`,
    };
  } finally {
    conn.release();
  }
}

/**
 * 获取所有数据库列表
 */
export async function listDatabases(): Promise<QueryResult> {
  return executeQuery(
    `SELECT datname AS "Database" FROM pg_database WHERE datistemplate = false ORDER BY datname`
  );
}

/**
 * 获取指定数据库的所有表
 */
export async function listTables(database?: string): Promise<QueryResult> {
  const db = database || getSessionDatabase();
  if (!db) {
    return {
      success: false,
      error: '未指定数据库，请在参数中提供或设置 PG_DATABASE',
    };
  }

  const sql = `
    SELECT 
      table_name as "name",
      NULL::text as "engine",
      NULL::bigint as "rows",
      NULL::bigint as "dataLength",
      NULL::timestamp as "createTime",
      NULL::timestamp as "updateTime",
      ''::text as "comment"
    FROM information_schema.tables
    WHERE table_catalog = $1 AND table_schema = 'public'
    ORDER BY table_name
  `;

  return executeQuery(sql, [db]);
}

/**
 * 获取表结构
 */
export async function describeTable(table: string): Promise<QueryResult> {
  if (!table) {
    return {
      success: false,
      error: '表名不能为空',
    };
  }

  const sql = `
    SELECT 
      c.column_name as "name",
      c.udt_name as "type",
      (c.is_nullable = 'YES') as "nullable",
      c.column_default as "defaultValue",
      ''::text as "comment",
      EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = c.table_schema
         AND tc.table_name = c.table_name
         AND kcu.column_name = c.column_name
      ) as "isPrimaryKey",
      (c.column_default LIKE 'nextval(%') as "isAutoIncrement"
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = $1
    ORDER BY ordinal_position
  `;

  return executeQuery(sql, [table]);
}

/**
 * 获取表索引信息
 */
export async function showIndexes(table: string): Promise<QueryResult> {
  if (!table) {
    return {
      success: false,
      error: '表名不能为空',
    };
  }

  const validationError = validateIdentifier(table, '表名');
  if (validationError) {
    return {
      success: false,
      error: validationError,
    };
  }

  return executeQuery(
    `SELECT
      indexname as "indexName",
      indexdef as "indexDef"
     FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = $1
     ORDER BY indexname`,
    [table]
  );
}

/**
 * 获取表创建语句
 */
export async function showCreateTable(table: string): Promise<QueryResult> {
  if (!table) {
    return {
      success: false,
      error: '表名不能为空',
    };
  }

  const validationError = validateIdentifier(table, '表名');
  if (validationError) {
    return {
      success: false,
      error: validationError,
    };
  }

  return executeQuery(
    `SELECT
      format(
        'CREATE TABLE %I.%I (\n%s\n);',
        n.nspname,
        c.relname,
        string_agg(
          format('  %I %s%s', a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END),
          E',\n'
          ORDER BY a.attnum
        )
      ) as "Create Table"
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relkind = 'r'
      AND n.nspname = 'public'
      AND c.relname = $1
      AND a.attnum > 0
      AND NOT a.attisdropped
    GROUP BY n.nspname, c.relname`,
    [table]
  );
}
