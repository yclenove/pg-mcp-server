import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatExplainRowsToText } from '../dist/explainTextFormat.js';

describe('formatExplainRowsToText', () => {
  it('空或非数组应返回空串', () => {
    assert.equal(formatExplainRowsToText([]), '');
    assert.equal(formatExplainRowsToText(null), '');
  });

  it('应拼接 PostgreSQL QUERY PLAN 行', () => {
    const rows = [
      { 'QUERY PLAN': 'Limit  (cost=0.15..5.38 rows=10 width=278)' },
      { 'QUERY PLAN': '  ->  Seq Scan on t  (cost=0..10 rows=1 width=4)' },
    ];
    const text = formatExplainRowsToText(rows);
    assert.ok(text.includes('Limit'));
    assert.ok(text.includes('Seq Scan'));
    assert.ok(text.includes('\n'));
  });

  it('应识别小写 query plan 列名', () => {
    const text = formatExplainRowsToText([{ 'query plan': 'Result  (cost=0..0 rows=1 width=4)' }]);
    assert.ok(text.includes('Result'));
  });

  it('无 QUERY PLAN 时应走 MySQL 风格行', () => {
    const text = formatExplainRowsToText([
      { id: 1, select_type: 'SIMPLE', table: 't', type: 'ALL', key: null, rows: 100, Extra: '' },
    ]);
    assert.ok(text.includes('id=1'));
    assert.ok(text.includes('access=ALL'));
  });
});
