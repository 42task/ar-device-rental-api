import { expect, it } from 'vitest';
import { migrate, validRootUniquenessExpression } from '../src/core/migrations';
import type { Database } from '../src/core/database';

it.each([
  "(case when (`role` = _latin1\\'root\\') then 1 else NULL end)",
  "(case when (`role` = _utf8mb4\\'root\\') then 1 else NULL end)",
  "(case when (`role` = _utf8mb3'root') then 1 else NULL end)",
  "case when (`role` = _ascii'root') then 1 else NULL end",
  "CASE WHEN role='root' THEN 1 ELSE NULL END",
])('accepts the root constraint in native MySQL expression format: %s', expression => {
  expect(validRootUniquenessExpression(expression)).toBe(true);
});

it.each([
  null, undefined, '', 'NULL', '1',
  "CASE WHEN role='admin' THEN 1 ELSE NULL END",
  "CASE WHEN role='adminer' THEN 1 ELSE NULL END",
  "CASE WHEN role='root_ascii' THEN 1 ELSE NULL END",
  "CASE WHEN role='r o o t' THEN 1 ELSE NULL END",
  "CASE WHEN role=_binary'ROOT' THEN 1 ELSE NULL END",
  "CASE WHEN other_role='root' THEN 1 ELSE NULL END",
  "CASE WHEN role='root' THEN id ELSE NULL END",
  "CASE WHEN role='root' THEN 1 ELSE 0 END",
])('rejects a column expression that does not globally constrain root: %s', expression => {
  expect(validRootUniquenessExpression(expression)).toBe(false);
});

it('refuses a database containing previous backend tables before making schema changes', async () => {
  const writes: string[] = [];
  const db: any = {
    withConnection: async (operation: (db: Database) => unknown) => operation(db),
    one: async () => ({ acquired: 1 }),
    query: async (sql: string) => sql === 'SHOW TABLES' ? [{ Tables_in_old: 'user' }, { Tables_in_old: 'device' }] : [],
    execute: async (sql: string) => { writes.push(sql); },
  };
  await expect(migrate(db)).rejects.toThrow('dedicated AR rental database');
  expect(writes).toEqual([]);
});

it('refuses legacy duplicate roots before any DDL or role changes', async () => {
  const writes: string[] = [];
  const db: any = {
    withConnection: async (operation: (db: Database) => unknown) => operation(db),
    one: async (sql: string) => sql.includes('GET_LOCK') ? { acquired: 1 } : { total: 2 },
    query: async (sql: string) => sql === 'SHOW TABLES' ? [{ Tables_in_test: 'ar_user' }, { Tables_in_test: 'ar_schema_meta' }] : [],
    execute: async (sql: string) => { writes.push(sql); },
  };
  await expect(migrate(db)).rejects.toThrow('Multiple root accounts');
  expect(writes).toEqual([]);
});
