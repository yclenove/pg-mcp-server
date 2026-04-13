/**
 * 将 EXPLAIN 结果行格式化为可读文本（PostgreSQL 文本计划或 MySQL 传统行）
 */

function formatMysqlExplainRow(row: Record<string, unknown>): string {
  const parts: string[] = [];
  if (row.id !== undefined) parts.push(`id=${row.id}`);
  if (row.select_type) parts.push(`type=${row.select_type}`);
  if (row.table) parts.push(`table=${row.table}`);
  if (row.type) parts.push(`access=${row.type}`);
  if (row.key) parts.push(`key=${row.key}`);
  if (row.rows !== undefined) parts.push(`rows=${row.rows}`);
  if (row.filtered !== undefined) parts.push(`filtered=${row.filtered}%`);
  if (row.Extra) parts.push(`extra=${row.Extra}`);
  return parts.join(', ');
}

/**
 * @param rows 驱动返回的 EXPLAIN 结果行
 */
export function formatExplainRowsToText(rows: unknown[]): string {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }

  const first = rows[0];
  if (first !== null && typeof first === 'object') {
    const o = first as Record<string, unknown>;
    const hasPgPlan =
      (typeof o['QUERY PLAN'] === 'string' && o['QUERY PLAN'].trim() !== '') ||
      (typeof o['query plan'] === 'string' && o['query plan'].trim() !== '');
    if (hasPgPlan) {
      return rows
        .map((raw) => {
          if (raw === null || typeof raw !== 'object') return '';
          const r = raw as Record<string, unknown>;
          const v = r['QUERY PLAN'] ?? r['query plan'];
          return typeof v === 'string' ? v : '';
        })
        .filter((s) => s.trim() !== '')
        .join('\n');
    }
  }

  return rows
    .map((row) => {
      if (row === null || typeof row !== 'object') return '';
      return formatMysqlExplainRow(row as Record<string, unknown>);
    })
    .join('\n');
}
