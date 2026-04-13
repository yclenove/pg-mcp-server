import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePostgresConnectionUrl } from '../dist/db/connection.js';

describe('parsePostgresConnectionUrl', () => {
  it('应解析标准 postgresql:// 连接串', () => {
    const r = parsePostgresConnectionUrl('postgresql://u:p@db.example.com:5433/mydb');
    assert.deepEqual(r, {
      host: 'db.example.com',
      port: 5433,
      user: 'u',
      password: 'p',
      database: 'mydb',
    });
  });

  it('应支持 postgres:// 协议', () => {
    const r = parsePostgresConnectionUrl('postgres://root@127.0.0.1:5432/test');
    assert.equal(r?.user, 'root');
    assert.equal(r?.host, '127.0.0.1');
    assert.equal(r?.port, 5432);
    assert.equal(r?.database, 'test');
    assert.equal(r?.password ?? '', '');
  });

  it('缺省端口不显式写入时 port 字段应为空', () => {
    const r = parsePostgresConnectionUrl('postgresql://a:b@host.only/dbname');
    assert.equal(r?.port, undefined);
    assert.equal(r?.host, 'host.only');
  });

  it('应对 URL 编码的密码解码', () => {
    const r = parsePostgresConnectionUrl('postgresql://u:p%40ss%3Aword@h:5432/d');
    assert.equal(r?.password, 'p@ss:word');
  });

  it('非法协议应返回 null', () => {
    assert.equal(parsePostgresConnectionUrl('mysql://u:p@h:3306/d'), null);
  });

  it('空串应返回 null', () => {
    assert.equal(parsePostgresConnectionUrl(''), null);
    assert.equal(parsePostgresConnectionUrl('   '), null);
  });
});
