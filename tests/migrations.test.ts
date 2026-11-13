import { expect, it } from 'vitest';
import { migrate } from '../src/core/migrations';
import type { Database } from '../src/core/database';

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
